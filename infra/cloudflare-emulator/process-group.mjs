export function signalProcessGroup(pid, signal, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error("Invalid child process group");
  if (signal !== "SIGTERM" && signal !== "SIGKILL")
    throw new Error("Invalid shutdown signal");
  try {
    kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function processGroupExists(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error("Invalid child process group");
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
