const fs = require("fs").promises;
const ROOT = "/sys/fs/cgroup";
const CGROUP_BASE = `${ROOT}/code-executor`;

async function write(file, value) {
  const h = await fs.open(file, "r+");
  try { await h.write(String(value)); } finally { await h.close(); }
}

exports.createCgroup = async (jobId, limit, resource) => {
  const cgroupPath = `${CGROUP_BASE}/${jobId}`;
  await fs.mkdir(CGROUP_BASE, { recursive: true });

  // enable controller at each level; log the real error
  for (const dir of [ROOT, CGROUP_BASE]) {
    try { await write(`${dir}/cgroup.subtree_control`, `+${resource}`); }
    catch (err) { console.error(`subtree_control (${dir}):`, err.message); }
  }

  await fs.mkdir(cgroupPath, { recursive: true });
  await write(`${cgroupPath}/${resource}.max`, limit);
  if (resource === "memory") {
    await write(`${cgroupPath}/memory.swap.max`, 0).catch(() => {});
  }
  return cgroupPath;
};

exports.addProcess = (cgroupPath, pid) =>
  write(`${cgroupPath}/cgroup.procs`, pid);

exports.removeCgroup = async (cgroupPath) => {
  await fs.writeFile(`${cgroupPath}/cgroup.kill`, "1").catch(() => {}); // kernel 5.14+
  await fs.rmdir(cgroupPath);
};