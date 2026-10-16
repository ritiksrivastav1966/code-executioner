const express = require('express');
const cors = require('cors');
const { spawn } = require('node:child_process');
const app = express();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { debug } = require('node:console');
app.use(express.json());
app.use(cors());
const compilePipeline = require('./compiler');


const port = 3000;
const server = app.listen(port ,()=>{
    console.log(`server running on ${port}`)
    console.log("Compiler started");
    console.log(process.platform);
});

app.use(express.static(path.join(__dirname,"public")));
app.post('/compile', async (req, res) => {
    const { code,language,input } = req.body;

    try {
        const result = await compilePipeline(code,language,input);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});