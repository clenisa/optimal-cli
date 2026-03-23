export { getDiscordClient, connectDiscord, disconnectDiscord } from './client.js'
export {
  listMappings, getMappingByThread, getMappingByTask, getMappingByProject,
  createMapping, deleteMapping, initProjectChannels,
  findOrphanedMappings, cleanupOrphanedMappings,
  type ChannelMapping, type OrphanedMapping,
} from './channels.js'
export { createThreadForTask, archiveThread, archiveThreadForTask, pushTasksToThreads, createTaskFromThread } from './threads.js'
export { handleReaction, handleTextCommand, setRequiredRole, withRetry } from './signals.js'
export { startWatch, type WatchOptions } from './watch.js'
export { diffDiscordSupabase, pullDiscordToSupabase, formatSyncDiff, type SyncDiff } from './sync.js'
