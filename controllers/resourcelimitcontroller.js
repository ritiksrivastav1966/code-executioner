const fs = require("fs").promises;

const CGROUP_BASE = "/sys/fs/cgroup/code-executor";

async function writeCgroupValue(file,value){
    const handle = await fs.open(file,"r+");

    try{
        await handle.write(String(value));
    } finally{
        await handle.close();
    }
}

exports.createCgroup = async (jobId,resourcelimit,resource) =>{
    const cgroupPath = `${CGROUP_BASE}/${jobId}`;
    await fs.mkdir(CGROUP_BASE,{recursive:true});
    try{
        await writeCgroupValue(`${CGROUP_BASE}/cgroup.subtree_control`,`+${resource}`);
    } catch(err){
        console.error(`Failed to enable ${resource} in subtree_control`);
    }
    await fs.mkdir(cgroupPath,{recursive:true});

    console.log(resource);
    console.log(cgroupPath);
    
    await writeCgroupValue(`${cgroupPath}/${resource}.max`,String(resourcelimit));
    return cgroupPath;

}

exports.addProcess = async(cgroupPath,pid)=>{
    await writeCgroupValue(`${cgroupPath}/cgroup.procs`,String(pid));
}