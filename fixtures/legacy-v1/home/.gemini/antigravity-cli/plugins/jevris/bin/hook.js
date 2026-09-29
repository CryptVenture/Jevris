import { stdin, stdout } from 'node:process';

const chunks = [];
stdin.on('data', (chunk) => {
  chunks.push(chunk);
});
stdin.on('end', () => {
  stdout.write('{}\n');
});
stdin.resume();
