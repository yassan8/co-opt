const fs = require('fs');
const s = fs.readFileSync('data/table-optical-system.js', 'utf8');
let stack = [];
const lines = s.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (c === '{' || c === '(' || c === '[') {
      stack.push({ c, i: i + 1, j: j + 1 });
    } else if (c === '}') {
      const last = stack.pop();
      if (!last || last.c !== '{') {
        console.log('mismatch } at', i + 1, 'line:', line.trim().slice(0, 120));
        console.log('stack tail:', stack.slice(-6));
      }
    } else if (c === ')') {
      const last = stack.pop();
      if (!last || last.c !== '(') {
        console.log('mismatch ) at', i + 1, 'line:', lines[i].trim().slice(0,120));
        console.log('stack tail:', stack.slice(-6));
      }
    } else if (c === ']') {
      const last = stack.pop();
      if (!last || last.c !== '[') {
        console.log('mismatch ] at', i + 1, 'line:', lines[i].trim().slice(0,120));
        console.log('stack tail:', stack.slice(-6));
      }
    }
  }
}
console.log('remaining stack size', stack.length);
if (stack.length > 0) {
  console.log('last unmatched:', stack.slice(-10));
}
