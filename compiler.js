const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { exitCode } = require('process');
//const { resolve } = require('dns');
const MAX_OUTPUT_BYTES = 50 * 1024;
async function compilePipeline(sourceCode, language, input = '') {
    const jobId = crypto.randomUUID();
    const buildDir = path.join(os.tmpdir(), `compiler-${jobId}`);

    try {
        await fs.mkdir(buildDir, { recursive: true });

        let fileName = 'main';
        if (language === 'python') fileName += '.py';
        else if (language === 'java') fileName = 'Main.java';
        else fileName += '.cpp';

        const sourcePath = path.join(buildDir, fileName);
        await fs.writeFile(sourcePath, sourceCode, 'utf8');

        let program;
        let pid;

        // --- LANGUAGE SPECIFIC LOGIC ---
        if (language === 'cpp') {
            const outputPath = path.join(buildDir, 'program.exe');

            // Compile C++ (Give it 5000ms to compile)
            const compiler = spawn('g++', [sourcePath, '-o', outputPath], { detached: true });
            const compileResult = await handleProcess(compiler, 5000, true, compiler.pid);

            if (compileResult.exitCode !== 0) {
                return ({
                    status: 'Compilation error',
                    exitCode: compileResult.exitCode,
                    error: compileResult.error
                });
                // return;
            }

            // Run C++
            program = spawn(outputPath, [], { detached: true });
            pid = program.pid;

        } else if (language === 'java') {
            // Compile Java (Give it 5000ms to compile)
            const compiler = spawn('javac', [sourcePath], { detached: true });
            const compileResult = await handleProcess(compiler, 20000, true, compiler.pid);

            if (compileResult.exitCode !== 0) {
                return ({
                    status: 'Compilation error',
                    exitCode: compileResult.exitCode,
                    error: compileResult.error
                });
            }

            // Run Java
            program = spawn('java', ['Main'], { cwd: buildDir, detached: true });
            pid = program.pid;

        } else if (language === 'python') {
            // Python, run it directly
            program = spawn('python', [sourcePath], { detached: true });
            pid = program.pid;
        } else {
            throw new Error("Unsupported language");
        }

        // --- SHARED EXECUTION LOGIC ---

        if (input) {
            program.stdin.write(input);

        }
        program.stdin.end();

        // Capture execution output (Give it 2000ms to execute)
        const executionResult = await handleProcess(program, 10000, false, pid);

        return {
            success: executionResult.exitCode === 0,
            ...executionResult
        };

    } finally {
        await fs.rm(buildDir, { recursive: true, force: true });
    }
}

// For execution of processes
function handleProcess(processInstance, timeoutMs, isCompileStep, pid) {
    return new Promise((resolve, reject) => {
        let output = '';
        let error = '';
        let outputBytes = 0;
        let terminationReason = null;


        const tleTimer = setTimeout(() => {
            if (processInstance.exitCode === null) {
                try {
                    terminationReason='TIME_LIMIT_EXCEDDED';
                    console.log(pid);
                    process.kill(-pid, 'SIGKILL');
                } catch (err) {
                    if (err.code !== 'ESRCH') {
                        console.error(err);
                    }
                }
            }
        }, 3000);

        processInstance.on('exit', () => {
            clearTimeout(tleTimer);
        });

        processInstance.stdout.on('data', (data) => {
            outputBytes += data.length;
            if (outputBytes > MAX_OUTPUT_BYTES) {
                terminationReason = 'OUTPUT_LIMIT_EXCEDDED';
                 if (processInstance.exitCode === null) {
                try {
                    process.kill(-pid, 'SIGKILL');
                } catch (err) {
                    if (err.code !== 'ESRCH') {
                        console.error(err);
                    }
                }
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
                try {
                    process.kill(-pid, 'SIGKILL');
                } catch (err) {
                    if (err.code !== 'ESRCH') {
                        console.error(err);
                    }
                }
            }
                return;
            }
            error += data.toString();
        });

        processInstance.on('error', (err) => {
            clearTimeout(tleTimer);
            reject(err);
        });

        processInstance.on('close', (code, signal) => {
            // 2. Clear the timer 
            clearTimeout(tleTimer);
            if (terminationReason === 'OUTPUT_LIMIT_EXCEDDED') {
                resolve({
                    status: 'OUTPUT_LIMIT_EXCEDDED',
                    output,
                    error,
                    outputBytes,
                    exitCode: -1
                });
                return;
            }
            if (terminationReason === 'TIME_LIMIT_EXCEDDED') {
                resolve({
                    status: 'TIME_LIMIT_EXCEDDED',
                    output,
                    error: 'Your code took too long',
                    outputBytes,
                    exitCode: -1
                });
                return;
            }

            resolve({
                status: code === 0 ? 'SUCCESS' : code === 3221225620 ? 'Division by zero error' : 'RUNTIME_ERROR',
                output,
                error,
                outputBytes,
                exitCode: code
            });
        });
    });
}

module.exports = compilePipeline;