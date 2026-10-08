/**
 * 文件管理已收口到 ide-workspace，避免再直接暴露安装根之外的磁盘。
 * 保留该路径，防止旧导入指向已删除文件。
 */
export { registerIdeWorkspace, IdeWorkspaceError, isInsideWorkspace } from '../ide-workspace.js';
export type { IdeEntry } from '../ide-workspace.js';
