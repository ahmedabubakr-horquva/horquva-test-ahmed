import * as fs from 'fs';
import * as path from 'path';

export function loadEnv(file = '.env'): void {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim();
    }
  }
}
