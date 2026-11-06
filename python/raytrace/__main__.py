# The `raytrace` command from pip. The wheel carries the npm package in app/
# and an official Node.js build in node/, so this only hands over to them: on
# macOS and Linux by replacing this process (the Claude Code hook runs
# `raytrace hook claude-code` on every tool call, and stdin, stdout and
# signals then reach Node untouched), on Windows as a child whose exit code
# becomes ours.
import os
import stat
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = os.path.join(HERE, 'node', 'node.exe' if os.name == 'nt' else 'node')
CLI = os.path.join(HERE, 'app', 'bin', 'raytrace.mjs')


def main():
    if not os.path.isfile(NODE):
        sys.exit(f'raytrace: the bundled Node.js is missing ({NODE}); reinstall with pip install --force-reinstall raytrace-cli')
    if os.name != 'nt' and not os.access(NODE, os.X_OK):
        # Some installers drop the executable bit that the wheel records.
        os.chmod(NODE, os.stat(NODE).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    args = [NODE, CLI, *sys.argv[1:]]
    if os.name == 'nt':
        try:
            sys.exit(subprocess.call(args))
        except KeyboardInterrupt:
            sys.exit(130)
    os.execv(NODE, args)


if __name__ == '__main__':
    main()
