# de-web-sdk evals for VS Code

A VS Code extension for agent pack producers. It runs a pack's evals with Copilot's models, guides trials in Copilot's own agent mode, and hosts blind trial review.

| Command | What it does |
|---|---|
| de-web-sdk: Run pack evals with Copilot models | Starts the eval bridge, then runs `de-web-sdk-pack eval run --local` in a terminal |
| de-web-sdk: Start the eval bridge for Copilot models | Lets the producer toolkit reach Copilot's models through VS Code's language model API |
| de-web-sdk: Stop the eval bridge | Stops the bridge and removes its address file |
| de-web-sdk: Start a guided Copilot trial | Opens a trial worktree in a new window and gives Copilot's agent mode the task prompt |
| de-web-sdk: Mark this guided trial finished | Grades the guided trial |
| de-web-sdk: Review eval trials | Opens each trial's changes in the diff editor for blind review |

The bridge listens only on `127.0.0.1`, requires a random token, and writes its address to a file only you can read. VS Code asks your consent before the first request to Copilot's models.

The extension ships as a VSIX file. See the [producer guide](https://github.com/roughcompass/de-web-sdk/blob/main/docs/producer-guide.md#run-evals) for how evals work.
