const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) {
      return fallback;
    }

    return JSON.parse(content);
  } catch (error) {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

class FileStore {
  constructor(filePath, fallbackState) {
    this.filePath = filePath;
    this.fallbackState = fallbackState;
  }

  load() {
    return readJsonFile(this.filePath, this.fallbackState);
  }

  save(state) {
    writeJsonFile(this.filePath, state);
  }
}

module.exports = {
  FileStore,
  ensureDir,
  readJsonFile,
  writeJsonFile,
};
