# Commands run in a login shell that is not interactive

A command runs as `"$SHELL" -lc '<command>'`, so the shell reads the user's profile files (`.profile`, `.bash_profile`, `.zprofile`) but not their rc files.
task-runner uses `-lic`, because tools like nvm, fnm and mise usually put themselves on `PATH` from `.zshrc` or `.bashrc`.
task-runner runs inside a terminal, though, and these commands have none: an interactive shell without one prints job-control warnings into every run's output, and some rc files break outright.
The cost is that a `PATH` change made only in an rc file does not reach these commands, and the README tells users to move it to their profile.
