# Each command's last run is kept on disk

The daemon writes each command's last run, with its status, exit code, times and output tail, to `last-runs.json` under `$PASEO_HOME/plugin-data/quick-commands/`.
Memory alone would lose the record whenever the plugin process restarts, and the commands this plugin exists for, such as reboot, restart exactly that process.
A run still marked running when the file loads is shown as interrupted, because the new process cannot tell how it ended; calling it failed would be a guess.
Paseo gives plugins no storage of their own besides settings, and settings can only be written from a client, so the file sits beside the ones task-runner keeps.
Only the last run is kept: there is no history.
