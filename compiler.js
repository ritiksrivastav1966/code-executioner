const fs = require('fs').promises;
const createFs = require('fs'); // Required for createReadStream
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cgroup = require('./controllers/resourcelimitcontroller');

const MAX_OUTPUT_BYTES = 50 * 1024;       // Max 50KB captured output
const MAX_INPUT_BYTES = 1 * 1024 * 1024;    // Max 1MB allowed for stdin

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
  const cgroupPath =   await cgroup.createCgroup(jobId,256*1024*1024,"memory");
    try {
        await fs.mkdir(buildDir, { recursive: true });

        let fileName = 'main';
        if (language === 'python') fileName += '.py';
        else if (language === 'java') fileName = 'Main.java';
        else fileName += '.cpp';

        const sourcePath = path.join(buildDir, fileName);
        await fs.writeFile(sourcePath, sourceCode, 'utf8');

        // 2. Write input to a temp file to prevent memory bloat and stream backpressure
        let inputPath = null;
        if (input) {
            inputPath = path.join(buildDir, 'input.txt');
            await fs.writeFile(inputPath, input, 'utf8');
        }

        let program;
        let pid;

        // --- LANGUAGE SPECIFIC LOGIC ---
        if (language === 'cpp') {
            const outputPath = path.join(buildDir, 'program');

            // Compile C++ (Give it 5000ms)
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

            // Run C++ with stdin streaming from input.txt
            const stdinStream = inputPath ? createFs.createReadStream(inputPath) : 'ignore';
            program = spawn(outputPath, [], { 
                detached: true,
                stdio: [stdinStream, 'pipe', 'pipe']
            });
            pid = program.pid;
         await   cgroup.addProcess(cgroupPath,pid);

        } else if (language === 'java') {
            // Compile Java (Give it 20000ms)
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

            // Run Java with stdin streaming from input.txt
            const stdinStream = inputPath ? createFs.createReadStream(inputPath) : 'ignore';
            program = spawn('java', ['Main'], { 
                cwd: buildDir, 
                detached: true,
                stdio: [stdinStream, 'pipe', 'pipe']
            });
            pid = program.pid;
            await   cgroup.addProcess(cgroupPath,pid);

        } else if (language === 'python') {
            // Python execution with stdin streaming
            const stdinStream = inputPath ? createFs.createReadStream(inputPath) : 'ignore';
            program = spawn('python3', [sourcePath], { 
                detached: true,
                stdio: [stdinStream, 'pipe', 'pipe']
            });
            pid = program.pid;
            await   cgroup.addProcess(cgroupPath,pid);
        } else {
            throw new Error("Unsupported language");
        }

        // --- SHARED EXECUTION LOGIC ---
        // Run execution (Give it 10000ms max)
        const executionResult = await handleProcess(program, 10000, pid);

        return {
            success: executionResult.exitCode === 0,
            ...executionResult
        };

    } finally {
        // Cleanup build directory securely
        await fs.rm(buildDir, { recursive: true, force: true });
    }
}

// Cross-platform helper to kill process or process tree cleanly
function killProcessTree(pid) {
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', pid, '/f', '/t']);
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
    return new Promise((resolve, reject) => {
        let output = '';
        let error = '';
        let outputBytes = 0;
        let terminationReason = null;

        const tleTimer = setTimeout(() => {
            if (processInstance.exitCode === null) {
                terminationReason = 'TIME_LIMIT_EXCEDDED';
                killProcessTree(pid);
            }
        }, timeoutMs);

        processInstance.stdout.on('data', (data) => {
            outputBytes += data.length;
            if (outputBytes > MAX_OUTPUT_BYTES) {
                terminationReason = 'OUTPUT_LIMIT_EXCEDDED';
                if (processInstance.exitCode === null) {
                    killProcessTree(pid);
                }
                return;
            }
            output += data.toString();
        });

        processInstance.stderr.on('data', (data) => {
            outputBytes += data.length;
            if (outputBytes > MAX_OUTPUT_BYTES) {
                terminationReason = 'OUTPUT_LIMIT_EXCEDDED';
                if (processInstance.exitCode === null) {
                    killProcessTree(pid);
                }
                return;
            }
            error += data.toString();
        });

        processInstance.on('error', (err) => {
            clearTimeout(tleTimer);
            reject(err);
        });

        processInstance.on('close', (code,signal) => {
            clearTimeout(tleTimer);

            if (terminationReason === 'OUTPUT_LIMIT_EXCEDDED') {
                return resolve({
                    status: 'OUTPUT_LIMIT_EXCEDDED',
                    output,
                    error: 'Output limit exceeded (max 50KB)',
                    outputBytes,
                    signal:signal,
                    exitCode: -1
                });
            }
            if (terminationReason === 'TIME_LIMIT_EXCEDDED') {
                return resolve({
                    status: 'TIME_LIMIT_EXCEDDED',
                    output,
                    error: 'Your code took too long (Time Limit Exceeded)',
                    outputBytes,
                    signal:signal,
                    exitCode: -1
                });
            }

            resolve({
                status: code === 0 ? 'SUCCESS' : 'RUNTIME_ERROR',
                output,
                error,
                outputBytes,
                signal:signal,
                exitCode: code
            });
        });
    });
}

module.exports = compilePipeline;