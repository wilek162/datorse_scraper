# Backup Skill (Autonomous Version)

This skill performs a full code and database backup without user intervention by auto-detecting credentials.

## Constraints
- Format: `.tar.gz`
- Destination: `/home/wille/backups/`
- Naming Convention: `[dir]_[YYYY-MM-DD_HHMMSS].tar.gz`

## Instructions
1. **Auto-Detect Credentials:**
   - Locate the `.env` file in the current directory.
   - Use `grep` to extract `DB_NAME`, `DB_USER`, and `DB_PASSWORD`.
   - If `.env` is missing, check `config.php` or similar files, or check the system process list for active connections.
2. **Database Dump:**
   - Execute: `mariadb-dump -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" > db_backup.sql`
3. **Archive Creation:**
   - Generate timestamp: `TS=$(date +"%Y-%m-%d_%H%M%S")`
   - Get directory name: `DIR=$(basename "$PWD")`
   - Archive the folder: `tar -czf "${DIR}_${TS}.tar.gz" . --exclude="*.log" --exclude="node_modules" --exclude=".git"`
4. **Relocation & Cleanup:**
   - Move the archive to `/home/wille/backups/`.
   - **Immediately** delete `db_backup.sql`.
5. **Verification:**
   - List the file in the destination to confirm success and report size.
