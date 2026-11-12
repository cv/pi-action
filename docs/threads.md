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
- In the `Save pi thread state` step of the action, which has `if: always()`. This step pushes commits that the main step did not push, for example after a crash or a timeout. It also saves the working tree one more time (see [Working-tree continuity](#working-tree-continuity)).

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

## Working-tree continuity

A thread also keeps the files that pi leaves uncommitted. Each run starts from a clean checkout. pi-action then restores the files as pi left them in the earlier run, staged and unstaged changes included. Thus, pi does not have to do its edits again after a question, a timeout, a cancellation, or a follow-up comment. To turn this off, set `worktree_snapshots: false`.

### What pi-action saves

pi-action saves a **snapshot** of the working tree after each model response and tool result, at the end of the run, and in the `Save pi thread state` step. It saves a snapshot only when the files changed since the last snapshot. A snapshot contains:

- Changes to tracked files: modified, deleted, staged, and partially staged files, file modes (such as the executable bit), and symbolic links.
- Untracked files that git does not ignore.
- Commits that pi made but did not push. The snapshot is based on the commit that `HEAD` points to, so these commits stay available.
- Submodules as the commit that they point to, and Git LFS files as their pointers (not the contents).

A snapshot does not contain:

- Files that git ignores (`.gitignore`, `.git/info/exclude`), for example `node_modules`, build output, or an ignored `.env`.
- Untracked files larger than `worktree_snapshot_max_file_mb` (default 10 MB).
- Untracked files past `worktree_snapshot_max_total_mb` for all untracked files of the snapshot (default 100 MB).
- Untracked files that match a glob in `worktree_snapshot_exclude` (default empty). A glob without `/` matches the file name (`.env*` matches `config/.env.local`). A glob with `/` matches the full path. `**` matches across directories.

These limits apply to untracked files only. Changes to tracked files are always saved. When pi-action does not save a file, the message to pi in the next run lists the file and the reason.

### Where pi-action stores snapshots

pi-action stores the snapshots of issue 42 on `refs/pi/worktrees/42`, next to `refs/pi/threads/42`, and pushes the two refs together in one atomic push (`git push --atomic`). Thus, the remote never has the conversation without its snapshot.

Each snapshot is a stash commit, as `git stash` makes it. On the ref, each snapshot has a wrapper commit. The parents of a wrapper commit are the earlier wrapper and the stash commit. The wrapper commit has these trailers:

| Trailer | Value |
|---------|-------|
| `Snapshot` | The stash commit |
| `Thread-Tip` | The commit of `refs/pi/threads/<number>` when pi-action saved the snapshot |
| `Thread-Entry` | The newest entry of the conversation when pi-action saved the snapshot |
| `Branch` | The branch, or `(detached)` |
| `Head` | The commit that `HEAD` pointed to |
| `Skipped` | An untracked file that the snapshot does not contain, and why (one trailer for each file) |

The conversation records which snapshot belongs to it, in a document that pi-action writes in the same commit as a `pi-action.worktree` entry. The model does not see the document or the entry. When the conversation is forked or rewound to an earlier entry, it gets the snapshot that was current at that entry.

### Inspect a snapshot

```bash
git fetch origin 'refs/pi/worktrees/42:refs/pi/worktrees/42'
git log --format='%h %s%n%b' refs/pi/worktrees/42      # one wrapper for each snapshot, newest first
snapshot=$(git log -1 --format='%(trailers:key=Snapshot,valueonly)' refs/pi/worktrees/42)
git stash show -p --include-untracked "$snapshot"     # the changes of the newest snapshot
git stash apply --index "$snapshot"                   # apply them to your checkout
```

### How pi-action restores a snapshot

At the start of a run, before pi continues any work, pi-action restores the snapshot that the conversation records:

1. **The branch.** If the branch exists only in the snapshot, pi-action makes it again at the recorded commit. If the checkout already contains the recorded commit, pi-action applies the snapshot to the checkout. If the branch on the remote moved past the recorded commit, pi-action checks out the branch and merges the snapshot into it. If the branch on the remote diverged from the recorded commit, pi-action does not restore the files.
2. **The files.** pi-action applies the snapshot as `git stash apply --index` does. If the staged changes do not apply, pi-action applies all changes as unstaged changes. If a file has conflicts, pi-action keeps the conflict markers in the file.
3. **The message.** pi-action tells pi in one message how the restore went: restored, restored without the staged changes, conflicts in these files, or not restored (with the stash commit, so that pi can apply it).

If the restore fails, pi-action resets the checkout, and pi starts from the clean checkout. A failed restore does not make the run fail. If the checkout has uncommitted changes to tracked files before the restore, pi-action does not restore the snapshot.

### Work that exists nowhere else

The newest snapshot on the ref is what pi worked on last. If the conversation records an older snapshot (for example, after a rewind), the newest snapshot can have work that the older snapshot does not have: changed files, or commits that are on no branch of the remote. Pushed commits do not count.

- If there is no such work, pi-action restores the older snapshot.
- If there is such work, pi-action does not change the files. It asks a question on the issue or pull request, which lists the files and the commits, and tells where they stay saved. The options are *Rewind files too*, *Keep the latest files, rewind only the conversation*, and *Cancel*. The run then ends. The answer starts the next run. See [Questions on GitHub](extensions.md#questions-on-github).
- If nobody can answer (in `output` mode, where pi-action posts nothing), pi-action keeps the files of the newest snapshot, and tells pi why.

pi-action never deletes a snapshot: all snapshots stay on the ref.

### When there are no snapshots

- With `worktree_snapshots: false`, pi-action saves and restores no snapshots.
- Direct prompts have no thread, so they have no snapshots.
- On pull requests from forks (`pull_request` events), the token cannot push, so pi-action saves no snapshots.
- With a token without `contents: write`, pi-action cannot push the refs. It writes a warning to the log, as for threads.

### Visibility

All people who can read the repository can read `refs/pi/worktrees/*`, also the untracked files in the snapshots. Make git ignore files with secrets, or add them to `worktree_snapshot_exclude`. See [Security](security.md#thread-contents-are-visible).

## Read a thread

The history of a thread is its git log. `git fetch` does not get custom refs by default. Get the ref first:

```bash
git fetch origin 'refs/pi/threads/42:refs/pi/threads/42'
git log --oneline refs/pi/threads/42            # one commit for each stored step
git show refs/pi/threads/42:batch.json | jq .   # the records of the newest step
```

The workflow log of each run on a thread shows these commands for that thread, in the group `How to read refs/pi/threads/<number> with git`, after the last push of the run. The job summary of the run shows them too. Each answer comment of pi-action shows the ref of its thread, and the `git fetch` command.

To get all threads with each `git fetch`, run this command one time:

```bash
git config --add remote.origin.fetch '+refs/pi/*:refs/pi/*'
```

All people who can read the repository can read these refs, also the output of tools. Keep secrets away from the agent, as for all CI jobs. See [Security](security.md#thread-contents-are-visible).

## Delete a thread

`git gc` does not make a thread smaller, because git can reach all of its history. To delete a thread, delete its refs:

```bash
git push origin :refs/pi/threads/42 :refs/pi/worktrees/42
```

The next `@pi` request on issue 42 then starts a new thread. pi-action does not delete the refs of closed issues or merged pull requests.
