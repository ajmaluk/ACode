#!/usr/bin/env python3
"""Fix empty catch blocks by adding DEV-guarded console.warn logging."""
import re

FILE_CONFIGS = {
    "apps/desktop/src/renderer/lib/dalamAPI.ts": {"prefix": "[DALAM]"},
    "apps/desktop/src/renderer/store/useAppStore.ts": {"prefix": "[Store]"},
    "apps/desktop/src/renderer/lib/memoryStore.ts": {"prefix": "[Memory]"},
    "apps/desktop/src/renderer/lib/verificationEngine.ts": {"prefix": "[Verify]"},
    "apps/desktop/src/renderer/lib/codeIndex.ts": {"prefix": "[CodeIndex]"},
    "apps/desktop/src/renderer/lib/instructions.ts": {"prefix": "[Instructions]"},
}


def get_try_context(lines, catch_idx):
    """Look backwards from catch line to find what the try block was doing."""
    for j in range(catch_idx - 1, max(catch_idx - 25, -1), -1):
        line = lines[j].strip()
        if line.startswith("try") or line == "try {":
            context_parts = []
            for k in range(j + 1, catch_idx):
                inner = lines[k].strip()
                if inner and not inner.startswith("//") and not inner.startswith("/*") and not inner.startswith("*"):
                    context_parts.append(inner)
                    if len(context_parts) >= 2:
                        break
            if context_parts:
                first_line = context_parts[0]
                if "await" in first_line:
                    op = first_line.split("await")[-1].strip()[:50]
                elif "import" in first_line:
                    op = "dynamic import"
                elif "JSON.parse" in first_line:
                    op = "JSON parse"
                elif "readDir" in first_line or "readFile" in first_line:
                    op = "filesystem read"
                elif "exists" in first_line:
                    op = "file exists check"
                elif "mkdir" in first_line:
                    op = "directory creation"
                elif "stat" in first_line:
                    op = "file stat"
                elif "rename" in first_line:
                    op = "file rename"
                elif "remove" in first_line:
                    op = "file removal"
                else:
                    op = first_line[:50]
                # Escape double quotes for JS string safety
                op = op.replace("\\", "\\\\").replace('"', '\\"')
                return op
            break
    return "operation"


def fix_file(filepath, prefix):
    with open(filepath, "r") as f:
        content = f.read()

    lines = content.split("\n")
    result = []
    fixed = 0
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Pattern 0: Full same-line try/catch like "try { ... } catch { ... }"
        m = re.match(
            r"^(\s*)try \{(.+?)\} catch \{(.*)\}$", line
        )
        if m:
            indent = m.group(1)
            try_body = m.group(2).strip()
            catch_body = m.group(3).strip()
            # Strip trailing */ if present in catch body
            catch_body_clean = re.sub(r"\s*/\*.*\*/\s*$", "", catch_body).strip()
            # Determine if the catch body is meaningful or just a comment
            if (
                catch_body_clean == ""
                or catch_body_clean.startswith("/*")
                or catch_body_clean == "ignore"
            ):
                # Empty/comment-only catch — add logging
                new_line = f'{indent}try {{{indent}  {try_body}}} catch (e) {{ if (import.meta.env.DEV) console.warn("{prefix} {try_body[:50]}", e); }}'
                result.append(new_line)
                fixed += 1
                i += 1
                continue
            else:
                # Catch has real body code (return, assignment, etc.) — expand to multiline
                result.append(f"{indent}try {{")
                result.append(f"{indent}  {try_body}")
                result.append(f"{indent}}} catch (e) {{")
                result.append(
                    f'{indent}  if (import.meta.env.DEV) console.warn("{prefix} {try_body[:50]}", e);'
                )
                result.append(f"{indent}  {catch_body}")
                result.append(f"{indent}}}")
                fixed += 1
                i += 1
                continue

        # Pattern 1: Single-line catch blocks like "} catch { /* ignore */ }"
        # or "} catch { return []; }"
        m = re.match(r"^(\s*)\} catch \{(.+)\}$", line)
        if m:
            indent = m.group(1)
            body = m.group(2).strip()
            context = get_try_context(lines, i)
            # Check if body is just a comment or return
            if re.match(r"^/\*.*\*/$", body) or body == "/* ignore */":
                # Empty catch with comment - replace entirely
                result.append(f"{indent}}} catch (e) {{")
                result.append(
                    f'{indent}  if (import.meta.env.DEV) console.warn("{prefix} {context}:", e);'
                )
                result.append(f"{indent}}}")
                fixed += 1
                i += 1
                continue
            elif body.startswith("return"):
                # catch with return - add logging before return
                result.append(f"{indent}}} catch (e) {{")
                result.append(
                    f'{indent}  if (import.meta.env.DEV) console.warn("{prefix} {context}:", e);'
                )
                result.append(f"{indent}  {body}")
                result.append(f"{indent}}}")
                fixed += 1
                i += 1
                continue
            else:
                # Other single-line catch with code
                result.append(f"{indent}}} catch (e) {{")
                result.append(
                    f'{indent}  if (import.meta.env.DEV) console.warn("{prefix} {context}:", e);'
                )
                result.append(f"{indent}  {body}")
                result.append(f"{indent}}}")
                fixed += 1
                i += 1
                continue

        # Pattern 2: } catch { on its own line (multi-line catch block)
        if stripped == "} catch {":
            context = get_try_context(lines, i)
            indent = line[: len(line) - len(line.lstrip())]

            # Scan forward past blank lines
            j = i + 1
            while j < len(lines) and lines[j].strip() == "":
                j += 1

            next_stripped = lines[j].strip() if j < len(lines) else ""

            # Case: closing brace immediately → empty catch block
            if next_stripped == "}":
                result.append(f"{indent}}} catch (e) {{")
                result.append(
                    f'{indent}  if (import.meta.env.DEV) console.warn("{prefix} {context}:", e);'
                )
                result.append(f"{indent}}}")
                i = j + 1
                fixed += 1
                continue

            # Case: /* ... */ comment then }
            if next_stripped.startswith("/*"):
                if "*/" in next_stripped:
                    comment_end = j
                else:
                    comment_end = j
                    while comment_end < len(lines):
                        if "*/" in lines[comment_end]:
                            break
                        comment_end += 1
                k = comment_end + 1
                while k < len(lines) and lines[k].strip() == "":
                    k += 1
                if k < len(lines) and lines[k].strip() == "}":
                    result.append(f"{indent}}} catch (e) {{")
                    result.append(
                        f'{indent}  if (import.meta.env.DEV) console.warn("{prefix} {context}:", e);'
                    )
                    result.append(f"{indent}}}")
                    i = k + 1
                    fixed += 1
                    continue

            # Case: catch has existing body code
            result.append(f"{indent}}} catch (e) {{")
            result.append(
                f'{indent}  if (import.meta.env.DEV) console.warn("{prefix} {context}:", e);'
            )
            i += 1
            fixed += 1
            continue

        result.append(line)
        i += 1

    with open(filepath, "w") as f:
        f.write("\n".join(result))

    return fixed


if __name__ == "__main__":
    total = 0
    for filepath, config in FILE_CONFIGS.items():
        count = fix_file(filepath, config["prefix"])
        print(f"Fixed {count} catch blocks in {filepath}")
        total += count
    print(f"\nTotal: {total} catch blocks fixed")
