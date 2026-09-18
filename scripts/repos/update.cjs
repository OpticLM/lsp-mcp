const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPOS_FILE = path.join(process.cwd(), "scripts", "repos", "repos.json");
const TARGET_PARENT_DIR = path.join(process.cwd(), "repos");

function main() {
  if (!fs.existsSync(REPOS_FILE)) {
    console.error(
      `Error: Cannot find '${REPOS_FILE}'. Please make sure it exists.`,
    );
    process.exit(1);
  }

  let repos;
  try {
    const content = fs.readFileSync(REPOS_FILE, "utf8");
    repos = JSON.parse(content);
  } catch (err) {
    console.error(`Error: Failed to parse '${REPOS_FILE}'.`, err.message);
    process.exit(1);
  }

  if (!Array.isArray(repos)) {
    console.error(`Error: 'repos.json' must contain an array of repositories.`);
    process.exit(1);
  }

  if (!fs.existsSync(TARGET_PARENT_DIR)) {
    fs.mkdirSync(TARGET_PARENT_DIR, { recursive: true });
  }

  for (const repo of repos) {
    if (!repo.url || !repo.name) {
      console.warn(`Skipping invalid repo entry:`, repo);
      continue;
    }

    const repoDir = path.join(TARGET_PARENT_DIR, repo.name);

    const tempDir = path.join(TARGET_PARENT_DIR, `.tmp-${repo.name}`);

    fs.rmSync(tempDir, { recursive: true, force: true });

    console.log(`\n==================================================`);
    console.log(`Processing [${repo.name}]...`);

    const isSha = repo.ref && /^[0-9a-f]{40}$/i.test(repo.ref);
    let success = false;

    if (isSha) {
      console.log(`Targeting Commit SHA: ${repo.ref}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const init = spawnSync("git", ["init"], {
        cwd: tempDir,
        stdio: "inherit",
      });
      const remote = spawnSync("git", ["remote", "add", "origin", repo.url], {
        cwd: tempDir,
        stdio: "inherit",
      });
      const fetch = spawnSync(
        "git",
        ["fetch", "--depth", "1", "origin", repo.ref],
        { cwd: tempDir, stdio: "inherit" },
      );
      const checkout = spawnSync("git", ["checkout", "FETCH_HEAD"], {
        cwd: tempDir,
        stdio: "inherit",
      });

      if (
        init.status === 0 &&
        remote.status === 0 &&
        fetch.status === 0 &&
        checkout.status === 0
      ) {
        success = true;
      }
    } else {
      console.log(`Targeting Branch/Tag: ${repo.ref || "default branch"}`);
      const args = ["clone", "--depth", "1"];
      if (repo.ref) {
        args.push("-b", repo.ref);
      }
      args.push(repo.url, tempDir);

      const clone = spawnSync("git", args, { stdio: "inherit" });
      if (clone.status === 0) {
        success = true;
      }
    }

    if (success) {
      try {
        const gitFolder = path.join(tempDir, ".git");
        fs.rmSync(gitFolder, { recursive: true, force: true });
        console.log(`Removed '.git' metadata to keep files plain.`);

        fs.rmSync(repoDir, { recursive: true, force: true });
        fs.renameSync(tempDir, repoDir);
        console.log(`[Success] Updated ${repo.name} at: ${repoDir}`);
      } catch (err) {
        console.error(
          `[Error] Failed to swap directories for ${repo.name}. File might be locked by another process (e.g. IDE or AI Agent).`,
          err.message,
        );
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } else {
      console.error(
        `[Error] Failed to download ${repo.name}. Cleaning up temp files...`,
      );
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  console.log("All repositories processed.");
}

main();
