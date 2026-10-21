"""Build the public source/extension ZIP using an explicit allowlist."""

from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text())["version"]
output = root / "dist" / f"roadster-startlux-driver-v{version}.zip"
output.parent.mkdir(exist_ok=True)

files = [root / name for name in (
    "README.md", "README.en.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json",
    "scripts/check.mjs", "scripts/package.py",
    "extension/.env.example",
)]
for directory in ("extension", "docs", "tests"):
    files.extend(
        path for path in sorted((root / directory).rglob("*"))
        if path.is_file()
        and not path.is_symlink()
        and not any(part.startswith(".") or part == "__pycache__"
                    for part in path.relative_to(root).parts)
    )

with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for path in files:
        if path.is_symlink():
            raise ValueError(f"Refusing symlink: {path.relative_to(root)}")
        archive.write(path, path.relative_to(root))

print(output)
