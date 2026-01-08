import * as esbuild from 'esbuild';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const distDir = path.join(process.cwd(), 'dist');

// Ensure output directory exists
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

console.log('Building Modu SQL for Browser...\n');

// Generate build timestamp banner with git commit hash
const buildDate = new Date().toISOString();
let commitHash = 'dev';
try {
    commitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {
    // Ignore if not in git repo
}
const banner = `/* Modu SQL - Built: ${buildDate} - Commit: ${commitHash} */`;

// Build IIFE bundle
async function buildIIFE(outDir, filename, minify = false) {
    await esbuild.build({
        entryPoints: ['src/index.ts'],
        bundle: true,
        format: 'iife',
        globalName: 'ModuSQL',
        outfile: path.join(outDir, filename),
        platform: 'browser',
        target: 'es2020',
        minify,
        banner: { js: banner },
        define: {
            'process.env.NODE_ENV': '"production"',
        },
    });
    console.log('Built:', path.join(outDir, filename));
}

// Build ESM bundle
async function buildESM(outDir, filename) {
    await esbuild.build({
        entryPoints: ['src/index.ts'],
        bundle: true,
        format: 'esm',
        outfile: path.join(outDir, filename),
        platform: 'browser',
        target: 'es2020',
        banner: { js: banner },
        define: {
            'process.env.NODE_ENV': '"production"',
        },
    });
    console.log('Built:', path.join(outDir, filename));
}

// Build all formats
await buildIIFE(distDir, 'modu-sql.iife.js', false);
await buildIIFE(distDir, 'modu-sql.min.js', true);
await buildESM(distDir, 'modu-sql.esm.js');

console.log('\nBuild complete!');
