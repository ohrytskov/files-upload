// Node.js fs File Operations Demo
const fs = require('fs');
const path = require('path');

function inspectDirectory(dirPath) {
  console.log(`Inspecting path: ${dirPath}`);
  const items = fs.readdirSync(dirPath);
  items.forEach(item => {
    const fullPath = path.join(dirPath, item);
    const stats = fs.statSync(fullPath);
    console.log(`- ${item} (${stats.size} bytes)`);
  });
}

inspectDirectory(__dirname);
