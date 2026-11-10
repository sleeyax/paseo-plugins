# Status comes from a shell wrapper

The daemon removes a terminal as soon as its process exits, and a terminal record has no exit code or running state, so the SDK cannot report a task's status.
Each task runs inside an `sh` wrapper that runs it in the user's login shell, prints an exit marker, and then replaces itself with an interactive shell so the output stays readable.
Status is read by finding the first exit marker in the terminal's output, since anything after it was typed into the leftover shell.
Exit codes cannot tell a stop from a failure, because an interrupted bash exits 1 and a server that shuts down cleanly exits 0, so the plugin remembers in memory which terminals it stopped.
The wrapper is POSIX `sh`, which is why Windows hosts are not supported yet.
