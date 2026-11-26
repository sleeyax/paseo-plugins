# Commands run as background processes, not terminals

A command runs as a child of the plugin's server process, with stdout and stderr captured, rather than in a Paseo terminal.
Paseo terminals belong to a workspace, and these commands belong to the host, so a terminal would mean picking some workspace to own each run.
A terminal also keeps no exit code, which task-runner works around with a shell wrapper that prints a marker; a child process reports its exit directly.
The cost is that a run cannot be opened as a terminal: the user sees only the last lines of its output, and the command can never read input.
Each run gets its own process group, so Stop signals everything the command started rather than only the shell.
