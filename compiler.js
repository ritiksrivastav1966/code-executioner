const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { exitCode } = require('process');
const MAX_OUTPUT_BYTES = 50*1024;
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

        // --- LANGUAGE SPECIFIC LOGIC ---
        if (language === 'cpp') {
            const outputPath = path.join(buildDir, 'program.exe');

            // Compile C++ (Give it 5000ms to compile)
            const compiler = spawn('g++', [sourcePath, '-o', outputPath]);
            const compileResult = await handleProcess(compiler, 5000, true);
            
            if (compileResult.exitCode !== 0) {
                return { success: false, ...compileResult };
            }

            // Run C++
            program = spawn(outputPath);

        } else if (language === 'java') {
            // Compile Java (Give it 5000ms to compile)
            const compiler = spawn('javac', [sourcePath]);
            const compileResult = await handleProcess(compiler, 20000, true);
            
            if (compileResult.exitCode !== 0) {
                return { success: false, ...compileResult };
            }

            // Run Java
            program = spawn('java', ['Main'], { cwd: buildDir });

        } else if (language === 'python') {
            // Python, run it directly
            program = spawn('python', [sourcePath]);
        } else {
            throw new Error("Unsupported language");
        }

        // --- SHARED EXECUTION LOGIC ---

        if (input) {
            program.stdin.write(input);
            
        }
        program.stdin.end();

        // Capture execution output (Give it 2000ms to execute)
        const executionResult = await handleProcess(program, 10000, false);

        return {
            success: executionResult.exitCode === 0,
            ...executionResult
        };

    } finally {
        await fs.rm(buildDir, { recursive: true, force: true });
    }
}

// For execution of processes
function handleProcess(processInstance, timeoutMs, isCompileStep) {
    return new Promise((resolve, reject) => {
        let output = '';
        let error = '';
        let outputBytes=0;
        let terminationReason=null;

        
        const tleTimer = setTimeout(() => {
             terminationReason='TIME_LIMIT_EXCEDDED';
            processInstance.kill('SIGKILL'); // Force kill 
        }, timeoutMs);

        processInstance.stdout.on('data', (data) => {
            outputBytes+=data.length;
            if(outputBytes>MAX_OUTPUT_BYTES){
                terminationReason='OUTPUT_LIMIT_EXCEDDED';
                processInstance.kill('SIGKILL');
                return;
            }
            output+=data.toString();
        });

        processInstance.stderr.on('data', (data) => {
           outputBytes+=data.length;
            if(outputBytes>MAX_OUTPUT_BYTES){
                terminationReason='OUTPUT_LIMIT_EXCEDDED';
                processInstance.kill('SIGKILL');
                return;
            }
            error+=data.toString();
        });

        processInstance.on('error', (err) => {
            clearTimeout(tleTimer);
            reject(err);
        });
      
        processInstance.on('close', (code, signal) => {
            // 2. Clear the timer 
            clearTimeout(tleTimer);
            if(terminationReason==='OUTPUT_LIMIT_EXCEDDED'){
                resolve({
                    status:'OUTPUT_LIMIT_EXCEDDED',
                    output,
                    error,
                    outputBytes,
                    exitCode:-1
                });
                return;
            }
             if(terminationReason==='TIME_LIMIT_EXCEDDED'){
                resolve({
                    status:'TIME_LIMIT_EXCEDDED',
                    output,
                    error:'Your code took too long',
                    outputBytes,
                    exitCode:-1
                });
                return;
            }
            // 3. Check for SIGKILL 
            resolve({
                status:code===0?'SUCCESS':'RUNTIME_ERROR',
                output,
                error,
                outputBytes,
                exitCode:code
            });
        });
    });
}

module.exports = compilePipeline;