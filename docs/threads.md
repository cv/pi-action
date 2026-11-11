# Durable threads

Each issue or pull request is one pi conversation, a **thread**. pi-action stores the thread in your repository, as a chain of git commits on `refs/pi/threads/<number>`. Thus, a later run continues the conversation on any runner, with all that pi saw and did before.

pi-action stores threads with [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). The storage code is in [`src/storage`](../src/storage). `refs/pi/threads/<number>` is a custom ref: it is not a branch, and GitHub does not show it as one.

## What has a thread

| Run | Thread |
|-----|--------|
| An `@pi` request on an issue or pull request | The thread of that issue or pull request |
| An answer to a question | The thread of the issue or pull request of the question |
| A `pr_number` run (for example from `workflow_dispatch`) | The thread of that pull request |
| A direct prompt (`prompt` without `pr_number`) | None. The conversation is in memory and pi-action stores nothing |

## When pi-action saves a thread

pi-action pushes the thread ref at these times:

- After each model response and each tool result.
- When the run is cancelled (SIGINT or SIGTERM).
- At the end of the run.
- In the `Save pi thread state` step of the action, which has `if: always()`. This step pushes commits that the main step did not push, for example after a crash or a timeout.

When a run stops before its work is complete, the next run on the thread continues the work.

To save threads, the job needs `contents: write`. Without it, the run works but cannot save the thread, and pi-action writes a warning to the log.

## Teams and concurrent runs

Use a `concurrency` group for each issue or pull request, with `cancel-in-progress: false`, as in the [quick start](../README.md#quick-start). Then runs on one thread do not overlap.

- **New comments join the running conversation.** pi-action looks for new `@pi` comments every `poll_interval` seconds (default 15) while pi works.
- **pi-action answers missed comments.** GitHub keeps only one pending run for each concurrency group, and cancels the others. Thus, a run answers each `@pi` comment on the thread that has no answer yet, not only the comment that started it.
- **pi-action posts each answer one time.** It records each posted answer and each posted failure in the thread. A later run does not post them again.

## Protection against conflicts

All pushes are fast-forward only.

- If two runs on one thread push at the same time, the remote rejects the later push. pi-action writes this to the log and does not overwrite the history of the other run. The run that was rejected stops pushing.
- pi-action retries other push failures (a network error, or `[remote rejected] ... (failed)` from GitHub) after 1, 3, and 10 seconds. If all retries fail, pi-action writes a warning to the log, and the next push tries again.

## Read a thread

The history of a thread is its git log. `git fetch` does not get custom refs by default. Get the ref first:

```bash
git fetch origin 'refs/pi/threads/42:refs/pi/threads/42'
git log --oneline refs/pi/threads/42            # one commit for each stored step
git show refs/pi/threads/42:batch.json | jq .   # the records of the newest step
```

Each answer comment of pi-action also shows the ref of its thread, and the `git fetch` command.

To get all threads with each `git fetch`, run this command one time:

```bash
git config --add remote.origin.fetch '+refs/pi/*:refs/pi/*'
```

All people who can read the repository can read these refs, also the output of tools. Keep secrets away from the agent, as for all CI jobs. See [Security](security.md#thread-contents-are-visible).

## Delete a thread

`git gc` does not make a thread smaller, because git can reach all of its history. To delete a thread, delete its ref:

```bash
git push origin :refs/pi/threads/42
```

The next `@pi` request on issue 42 then starts a new thread.
