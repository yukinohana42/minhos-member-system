export interface BackupPolicy {
  kind: "daily" | "monthly";
  retentionDays: number;
  minimumGenerations: number;
  maxDeletesPerRun: number;
}

export interface BackupCandidate {
  id: string;
  createdAt: Date;
}

export function backupPolicy(kind: "daily" | "monthly", retentionDays: number): BackupPolicy {
  if (!Number.isFinite(retentionDays) || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("BACKUP_RETENTION_DAYS_OUT_OF_SAFE_RANGE");
  }
  return kind === "daily"
    ? { kind, retentionDays, minimumGenerations: 7, maxDeletesPerRun: 10 }
    : { kind, retentionDays, minimumGenerations: 3, maxDeletesPerRun: 2 };
}

export function planBackupDeletions(
  candidates: BackupCandidate[],
  now: Date,
  policy: BackupPolicy,
): string[] {
  if (!Number.isFinite(now.getTime())) throw new Error("BACKUP_NOW_INVALID");
  const unique = [...new Map(candidates.map((item) => [item.id, item])).values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const protectedIds = new Set(unique.slice(0, policy.minimumGenerations).map(({ id }) => id));
  const thresholdMs = now.getTime() - policy.retentionDays * 86_400_000;
  return unique
    .filter(({ id, createdAt }) => !protectedIds.has(id) && createdAt.getTime() < thresholdMs)
    .slice(0, policy.maxDeletesPerRun)
    .map(({ id }) => id);
}

export function backupSpreadsheet(input: {
  spreadsheetId: string;
  backupFolderId: string;
  retentionDays: number;
  kind: "daily" | "monthly";
  now: Date;
}): { copyId: string; removed: number } {
  // Validate every destructive-policy input before the first Drive operation.
  const policy = backupPolicy(input.kind, input.retentionDays);
  if (!Number.isFinite(input.now.getTime())) throw new Error("BACKUP_NOW_INVALID");

  const source = DriveApp.getFileById(input.spreadsheetId);
  const folder = DriveApp.getFolderById(input.backupFolderId);
  const timestamp = Utilities.formatDate(input.now, "Asia/Tokyo", "yyyyMMdd-HHmmss");
  const prefix = `minhos-members-${input.kind}-`;
  const copy = source.makeCopy(`${prefix}${timestamp}`, folder);
  const byId = new Map<string, GoogleAppsScript.Drive.File>();
  const candidates: BackupCandidate[] = [{ id: copy.getId(), createdAt: new Date(copy.getDateCreated().getTime()) }];
  byId.set(copy.getId(), copy);
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (!file.getName().startsWith(prefix)) continue;
    byId.set(file.getId(), file);
    candidates.push({ id: file.getId(), createdAt: new Date(file.getDateCreated().getTime()) });
  }

  const deletions = planBackupDeletions(candidates, input.now, policy);
  for (const id of deletions) byId.get(id)?.setTrashed(true);
  return { copyId: copy.getId(), removed: deletions.length };
}

export function shouldRetainBackup(createdAt: Date, now: Date, retentionDays = 35): boolean {
  const policy = backupPolicy("daily", retentionDays);
  return createdAt.getTime() >= now.getTime() - policy.retentionDays * 86_400_000;
}
