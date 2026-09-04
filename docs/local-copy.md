# Local Commander copy

Commander View operates on the filesystem of the machine running CloudVault. It can therefore copy between ordinary directories, Windows drives, UNC paths, and removable media mounted on that machine.

## Web UI

1. Enter a directory in either panel and choose **Go**. Examples include `C:\\`, `D:\\Backups`, `\\\\server\\share`, `/mnt/usb`, and `/media/flash`.
2. Double-click a directory to open it, or use the up-arrow button to go to its parent.
3. Select files or directories and use **Copy selected to right** or **Copy selected to left**.
4. Existing files are protected by default. Enable **Replace existing files** when replacing files is intentional.

Directories are copied recursively. Symbolic links and special filesystem entries are shown but are not copied.

## CLI

The same copy engine is available without the web UI:

```bash
# Copy everything in a directory
npm run local-copy -- --source "D:\\Photos" --destination "E:\\Backup"

# Copy one entry from a mounted flash drive
npm run local-copy -- --source "/media/flash/photos" --destination "/data/archive" --entry 2026

# Replace destination files when they already exist
npm run local-copy -- --source "C:\\Work" --destination "D:\\Backup" --replace-existing
```

The web API is protected by `CLOUDVAULT_AUTH_TOKEN` whenever authentication is enabled. Do not expose an unauthenticated server beyond loopback: local copy intentionally grants access to directories visible to the server process.
