use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::command;

#[derive(Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub modified: Vec<String>,
    pub added: Vec<String>,
    pub deleted: Vec<String>,
    pub untracked: Vec<String>,
    pub ahead: i32,
    pub behind: i32,
}

#[derive(Serialize, Deserialize)]
pub struct GitCommit {
    pub sha: String,
}

#[derive(Serialize, Deserialize)]
pub struct GitLogEntry {
    pub sha: String,
    pub message: String,
    pub date: String,
    pub author: String,
}

fn count_ahead_behind(path: &str, branch: &str) -> (i32, i32) {
    let output = Command::new("git")
        .args(["rev-list", "--left-right", "--count", &format!("{}...{}@{{upstream}}", branch, branch)])
        .current_dir(path)
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout);
            let parts: Vec<&str> = s.trim().split('\t').collect();
            if parts.len() == 2 {
                let ahead = parts[0].parse().unwrap_or(0);
                let behind = parts[1].parse().unwrap_or(0);
                (ahead, behind)
            } else {
                (0, 0)
            }
        }
        _ => (0, 0),
    }
}

#[command]
pub fn git_status(path: String) -> Result<GitStatus, String> {
    let branch_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !branch_output.status.success() {
        let err = String::from_utf8_lossy(&branch_output.stderr).to_string();
        return Err(format!("git rev-parse failed: {}", err));
    }

    let branch = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();

    let status_output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !status_output.status.success() {
        let err = String::from_utf8_lossy(&status_output.stderr).to_string();
        return Err(format!("git status failed: {}", err));
    }

    let status_str = String::from_utf8_lossy(&status_output.stdout);
    let mut modified = Vec::new();
    let mut added = Vec::new();
    let mut deleted = Vec::new();
    let mut untracked = Vec::new();

    for line in status_str.lines() {
        if line.len() < 3 { continue; }
        let status_code = &line[..2];
        let mut file_path = line[3..].to_string();

        // Handle rename/copy entries: "R  oldname -> newname" → just "newname"
        if (status_code.starts_with('R') || status_code.starts_with('C')) && file_path.contains(" -> ") {
            if let Some(new_path) = file_path.split(" -> ").nth(1) {
                file_path = new_path.to_string();
            }
        }

        match status_code {
            "M " | " M" | "MM" | "AM" | "RM" | "CM" => modified.push(file_path),
            "A " | " A" | "R " | "C " => added.push(file_path),
            "D " | " D" => deleted.push(file_path),
            "??" => untracked.push(file_path),
            "UU" => modified.push(file_path),
            _ => {
                if status_code.contains('M') { modified.push(file_path); }
                else if status_code.contains('A') { added.push(file_path); }
                else if status_code.contains('D') { deleted.push(file_path); }
                else if status_code.contains('U') { modified.push(file_path); }
            }
        }
    }

    let (ahead, behind) = count_ahead_behind(&path, &branch);

    Ok(GitStatus {
        branch,
        modified,
        added,
        deleted,
        untracked,
        ahead,
        behind,
    })
}

#[command]
pub fn git_commit(path: String, message: String) -> Result<GitCommit, String> {
    let output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("git commit failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git commit failed: {}", stderr));
    }

    let sha_output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("git rev-parse failed: {}", e))?;

    let sha = String::from_utf8_lossy(&sha_output.stdout).trim().to_string();

    Ok(GitCommit { sha })
}

#[command]
pub fn git_log(path: String, limit: Option<i32>) -> Result<Vec<GitLogEntry>, String> {
    let count = limit.unwrap_or(20);
    let output = Command::new("git")
        .args([
            "log",
            &format!("-{}", count),
            "--pretty=format:%H||%s||%aI||%an",
        ])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("git log failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git log failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries: Vec<GitLogEntry> = stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(4, "||").collect();
            if parts.len() == 4 {
                Some(GitLogEntry {
                    sha: parts[0].to_string(),
                    message: parts[1].to_string(),
                    date: parts[2].to_string(),
                    author: parts[3].to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(entries)
}

#[derive(Serialize, Deserialize)]
pub struct GitBranchInfo {
    pub name: String,
    pub current: bool,
}

#[command]
pub fn git_branches(path: String) -> Result<Vec<GitBranchInfo>, String> {
    let output = Command::new("git")
        .args(["branch", "--list"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("git branch failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let branches: Vec<GitBranchInfo> = stdout
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            let current = trimmed.starts_with("*");
            let name = trimmed.trim_start_matches("* ").trim().to_string();
            GitBranchInfo { name, current }
        })
        .filter(|b| !b.name.is_empty())
        .collect();

    Ok(branches)
}

#[command]
pub fn git_checkout(path: String, branch: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["checkout", "--", &branch])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("git checkout failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git checkout failed: {}", stderr));
    }

    Ok(())
}

#[command]
pub fn git_create_branch(path: String, name: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["checkout", "-b", &name])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("git create branch failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git create branch failed: {}", stderr));
    }

    Ok(())
}

#[command]
pub fn git_diff_file(path: String, file_path: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(["diff", "--no-color", "--", &file_path])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("git diff failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git diff failed: {}", stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
