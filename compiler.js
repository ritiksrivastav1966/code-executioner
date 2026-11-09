const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cgroup = require('./controllers/resourcelimitcontroller');

const MAX_OUTPUT_BYTES = 50 * 1024;          // Max 50KB captured output
const MAX_INPUT_BYTES = 1 * 1024 * 1024;     // Max 1MB allowed for stdin
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024; // 256MB per run

async function compilePipeline(sourceCode, language, input = '') {
    // 1. Enforce strict input size validation
    if (input && Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
        return {
            success: false,
            status: 'INPUT_LIMIT_EXCEEDED',
            error: 'Input data is too large (max 1MB allowed)',
            exitCode: -1
        };
    }

    const jobId = crypto.randomUUID();
    const buildDir = path.join(os.tmpdir(), `compiler-${jobId}`);
    let cgroupPath = null;

    try {
        // Created inside try so any failure returns an error instead of hanging
        cgroupPath = await cgroup.createCgroup(jobId, MEMORY_LIMIT_BYTES, 'memory');

        await fs.mkdir(buildDir, { recursive: true });

        let fileName = 'main';
        if (language === 'python') fileName += '.py';
        else if (language === 'java') fileName = 'Main.java';
        else if (language === 'cpp') fileName += '.cpp';
        else throw new Error('Unsupported language');

        const sourcePath = path.join(buildDir, fileName);
        await fs.writeFile(sourcePath, sourceCode, 'utf8');

        // 2. Write input to a temp file to prevent memory bloat and backpressure
        let inputPath = null;
        if (input) {
            inputPath = path.join(buildDir, 'input.txt');
            await fs.writeFile(inputPath, input, 'utf8');
        }

        // --- LANGUAGE SPECIFIC LOGIC ---
        let cmd, args, cwd;

        if (language === 'cpp') {
            const outputPath = path.join(buildDir, 'program');
            const compiler = spawn('g++', [sourcePath, '-o', outputPath], { detached: true });
            const compileResult = await handleProcess(compiler, 5000, compiler.pid);

            if (compileResult.exitCode !== 0) {
                return {
                    success: false,
                    status: 'Compilation error',
                    exitCode: compileResult.exitCode,
                    error: compileResult.error || compileResult.output
                };
            }
            cmd = outputPath;
            args = [];
            cwd = buildDir;

        } else if (language === 'java') {
            const compiler = spawn('javac', [sourcePath], { detached: true });
            const compileResult = await handleProcess(compiler, 20000, compiler.pid);

            if (compileResult.exitCode !== 0) {
                return {
                    success: false,
                    status: 'Compilation error',
                    exitCode: compileResult.exitCode,
                    error: compileResult.error || compileResult.output
                };
            }
            cmd = 'java';
            args = ['Main'];
            cwd = buildDir;

        } else {
            cmd = 'python3';
            args = [sourcePath];
            cwd = buildDir;
        }

        // --- SHARED EXECUTION LOGIC ---
        const executionResult = await runInCgroup(cmd, args, cwd, inputPath, cgroupPath);
        return {
            success: executionResult.exitCode === 0,
            ...executionResult
        };

    } catch (err) {
        console.error('compilePipeline error:', err);
        return {
            success: false,
            status: 'INTERNAL_ERROR',
            error: err.message,
            exitCode: -1
        };
    } finally {
        await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});
        if (cgroupPath) {
            await cgroup.removeCgroup(cgroupPath).catch((e) =>
                console.error('cgroup cleanup failed:', e.message)
            );
        }
    }
}

// Spawns the program, attaches listeners first, then moves it into the cgroup
async function runInCgroup(cmd, args, cwd, inputPath, cgroupPath) {
    let inputHandle = null;
    let program;

    try {
        // Pass a real file descriptor (a ReadStream may not be open yet when spawn runs)
        if (inputPath) inputHandle = await fs.open(inputPath, 'r');

        program = spawn(cmd, args, {
            cwd,
            detached: true,
            stdio: [inputHandle ? inputHandle.fd : 'ignore', 'pipe', 'pipe']
        });
    } finally {
        // Child has its own copy of the fd now
        if (inputHandle) await inputHandle.close().catch(() => {});
    }

    const pid = program.pid;

    // Attach listeners BEFORE any await so fast programs can't finish unobserved
    const execPromise = handleProcess(program, 10000, pid);

    // pid is undefined if spawn failed; handleProcess resolves with SPAWN_ERROR
    if (pid) {
        try {
            await cgroup.addProcess(cgroupPath, pid);
        } catch (err) {
            killProcessTree(pid);
            await execPromise.catch(() => {});
            throw err;
        }
    }

    return execPromise;
}

// Cross-platform helper to kill process or process tree cleanly
function killProcessTree(pid) {
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/f', '/t']);
        } else {
            process.kill(-pid, 'SIGKILL');
        }
    } catch (err) {
        if (err.code !== 'ESRCH') {
            console.error(err);
        }
    }
}

// For execution of processes
function handleProcess(processInstance, timeoutMs, pid) {
    return new Promise((resolve) => {
        let output = '';
        let error = '';
        let outputBytes = 0;
        let terminationReason = null;
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(tleTimer);
            resolve(result);
        };

        const tleTimer = setTimeout(() => {
            if (processInstance.exitCode === null) {
                terminationReason = 'TIME_LIMIT_EXCEEDED';
                killProcessTree(pid);
            }
        }, timeoutMs);

        const capture = (data, isStdout) => {
            outputBytes += data.length;

            if (outputBytes > MAX_OUTPUT_BYTES) {
                terminationReason = 'OUTPUT_LIMIT_EXCEEDED';
                if (processInstance.exitCode === null) {
                    killProcessTree(pid);
                }
                return;
            }

            if (isStdout) output += data.toString();
            else error += data.toString();
        };

        processInstance.stdout.on('data', (d) => capture(d, true));
        processInstance.stderr.on('data', (d) => capture(d, false));

        processInstance.on('error', (err) => {
            finish({
                status: 'SPAWN_ERROR',
                output,
                error: err.message,
                outputBytes,
                exitCode: -1
            });
        });

        // 'close' fires once the process has exited and stdio is closed
        processInstance.on('close', (code, signal) => {
            if (terminationReason === 'OUTPUT_LIMIT_EXCEEDED') {
                return finish({
                    status: 'OUTPUT_LIMIT_EXCEEDED',
                    output,
                    error: 'Output limit exceeded (max 50KB)',
                    outputBytes,
                    signal,
                    exitCode: -1
                });
            }

            if (terminationReason === 'TIME_LIMIT_EXCEEDED') {
                return finish({
                    status: 'TIME_LIMIT_EXCEEDED',
                    output,
                    error: 'Your code took too long (Time Limit Exceeded)',
                    outputBytes,
                    signal,
                    exitCode: -1
                });
            }

            // Killed by the kernel with no reason from us: most likely the cgroup OOM killer
            if (signal === 'SIGKILL') {
                return finish({
                    status: 'MEMORY_LIMIT_EXCEEDED',
                    output,
                    error: 'Process was killed (likely Memory Limit Exceeded)',
                    outputBytes,
                    signal,
                    exitCode: -1
                });
            }

            finish({
                status: code === 0 ? 'SUCCESS' : 'RUNTIME_ERROR',
                output,
                error,
                outputBytes,
                signal,
                exitCode: code
            });
        });
    });
}

module.exports = compilePipeline;