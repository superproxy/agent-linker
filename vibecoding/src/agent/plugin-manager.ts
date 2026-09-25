import type { CommandType } from '../protocol/index.js';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

/** 插件基础接口 */
export interface AgentPlugin {
  /** 插件名称，唯一标识 */
  name: string;
  /** 插件描述 */
  description: string;
  /** 插件版本 */
  version: string;
  /** 支持的命令列表 */
  supportedCommands: CommandType[];
  /** 插件初始化 */
  init?: () => Promise<void>;
  /** 命令处理函数 */
  handleCommand: (command: CommandType, params: Record<string, any>) => Promise<any>;
  /** 插件销毁 */
  destroy?: () => Promise<void>;
  /** 测试用例 */
  testCases?: Array<{
    name: string;
    command: CommandType;
    params: Record<string, any>;
    expect: (result: any) => boolean | Promise<boolean>;
  }>;
}

/**
 * 插件管理器
 * 动态加载、管理、执行插件
 */
export class PluginManager {
  private plugins = new Map<string, AgentPlugin>();
  private commandMap = new Map<CommandType, AgentPlugin>();

  constructor(private pluginDir: string = join(__dirname, 'plugins')) {}

  /** 加载所有插件 */
  async loadAll() {
    if (!existsSync(this.pluginDir)) return;
    
    const files = readdirSync(this.pluginDir);
    for (const file of files) {
      const filePath = join(this.pluginDir, file);
      if (statSync(filePath).isFile() && extname(file) === '.js') {
        try {
          const pluginModule = await import(filePath);
          const plugin: AgentPlugin = pluginModule.default;
          await this.loadPlugin(plugin);
        } catch (err) {
          console.error(`[plugin] Failed to load plugin ${file}:`, err);
        }
      }
    }
    console.log(`[plugin] Loaded ${this.plugins.size} plugins, supported commands: ${Array.from(this.commandMap.keys()).join(', ')}`);
  }

  /** 加载单个插件 */
  async loadPlugin(plugin: AgentPlugin) {
    if (this.plugins.has(plugin.name)) {
      console.warn(`[plugin] Plugin ${plugin.name} already loaded, skipping`);
      return;
    }
    if (plugin.init) await plugin.init();
    this.plugins.set(plugin.name, plugin);
    for (const cmd of plugin.supportedCommands) {
      this.commandMap.set(cmd, plugin);
    }
    console.log(`[plugin] Loaded plugin ${plugin.name} v${plugin.version}`);
  }

  /** 卸载插件 */
  async unloadPlugin(name: string) {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    if (plugin.destroy) await plugin.destroy();
    for (const cmd of plugin.supportedCommands) {
      this.commandMap.delete(cmd);
    }
    this.plugins.delete(name);
    console.log(`[plugin] Unloaded plugin ${name}`);
  }

  /** 执行命令 */
  async executeCommand(command: CommandType, params: Record<string, any>): Promise<any> {
    const plugin = this.commandMap.get(command);
    if (!plugin) throw new Error(`Unsupported command: ${command}`);
    return plugin.handleCommand(command, params);
  }

  /** 获取支持的所有命令 */
  getSupportedCommands(): CommandType[] {
    return Array.from(this.commandMap.keys());
  }

  /** 获取所有插件 */
  getPlugins(): AgentPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** 运行所有插件的测试用例 */
  async runAllTests(): Promise<{
    total: number;
    passed: number;
    failed: number;
    results: Array<{ plugin: string; testName: string; passed: boolean; error?: string }>;
  }> {
    const results: any[] = [];
    let total = 0;
    let passed = 0;

    for (const plugin of this.plugins.values()) {
      if (!plugin.testCases || plugin.testCases.length === 0) continue;
      console.log(`[plugin] Running tests for ${plugin.name}...`);
      for (const test of plugin.testCases) {
        total++;
        try {
          const result = await plugin.handleCommand(test.command, test.params);
          const isPassed = await test.expect(result);
          if (isPassed) {
            passed++;
            results.push({ plugin: plugin.name, testName: test.name, passed: true });
            console.log(`  ✅ ${test.name}`);
          } else {
            results.push({ plugin: plugin.name, testName: test.name, passed: false, error: 'Result not match expected' });
            console.log(`  ❌ ${test.name}: Result not match expected`);
          }
        } catch (err) {
          results.push({ plugin: plugin.name, testName: test.name, passed: false, error: (err as Error).message });
          console.log(`  ❌ ${test.name}: ${(err as Error).message}`);
        }
      }
    }

    console.log(`[plugin] Test run complete: ${passed}/${total} passed`);
    return { total, passed, failed: total - passed, results };
  }
}
