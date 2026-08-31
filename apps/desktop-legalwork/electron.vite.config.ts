import { cpSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

function copyPdfJsAssetsPlugin() {
  return {
    name: 'copy-pdfjs-assets',
    closeBundle(): void {
      const targetRoot = resolve('out/renderer/pdfjs')
      mkdirSync(targetRoot, { recursive: true })
      cpSync(resolve('node_modules/pdfjs-dist/cmaps'), resolve(targetRoot, 'cmaps'), {
        recursive: true,
        force: true
      })
      cpSync(resolve('node_modules/pdfjs-dist/standard_fonts'), resolve(targetRoot, 'standard_fonts'), {
        recursive: true,
        force: true
      })
    }
  }
}

export default defineConfig({
  main: {
    // 打包时把自动更新源注入为 process.env.LEGALWORK_UPDATE_URL,
    // 否则打包后读不到 env,应用会回落走 GitHub(国内更新到一半断)。
    // 可从构建环境 LEGALWORK_UPDATE_URL 覆盖;默认指向腾讯云 COS。
    define: {
      'process.env.LEGALWORK_UPDATE_URL': JSON.stringify(
        (process.env.LEGALWORK_UPDATE_URL || '').trim() ||
          'https://legalwork-1318565101.cos.ap-guangzhou.myqcloud.com/legalwork/channels/{channel}/latest/'
      )
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'claw-schedule-mcp-node-entry': resolve('src/main/claw-schedule-mcp-node-entry.ts'),
          'filesystem-mcp-node-entry': resolve('src/main/filesystem-mcp-node-entry.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    server: {
      proxy: {
        '/api': 'http://127.0.0.1:5100',
        '/result': 'http://127.0.0.1:5100'
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), copyPdfJsAssetsPlugin()]
  }
})
