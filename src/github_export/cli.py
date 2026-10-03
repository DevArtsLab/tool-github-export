"""github-export CLI."""

from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from . import __version__
from .client import GitHubClient, GitHubClientError, resolve_token
from .config import DEFAULT_CONFIG_PATH, load_config
from .exporter import run_export

app = typer.Typer(
    name="github-export",
    help="Export GitHub repository metadata to versioned JSON artifacts.",
    no_args_is_help=True,
)
console = Console()
err_console = Console(stderr=True)

def _schema_text() -> str:
    # In a source checkout the schema lives at <repo>/schemas/; in an installed
    # wheel it is bundled at github_export/schemas/ via hatch force-include.
    bundled = files("github_export") / "schemas" / "repos.schema.json"
    if bundled.is_file():
        return bundled.read_text()
    repo_file = (
        Path(__file__).resolve().parents[2] / "schemas" / "repos.schema.json"
    )
    if repo_file.exists():
        return repo_file.read_text()
    raise FileNotFoundError("repos.schema.json not found in package or repo")


def _version_callback(value: bool) -> None:
    if value:
        console.print(f"github-export {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: Annotated[
        bool, typer.Option("--version", callback=_version_callback, is_eager=True)
    ] = False,
) -> None:
    """Export GitHub repository metadata to versioned JSON artifacts."""


@app.command()
def export(
    config: Annotated[
        Path, typer.Option("--config", "-c", help="Path to export.config.yaml")
    ] = DEFAULT_CONFIG_PATH,
    out_dir: Annotated[
        Path | None, typer.Option("--out-dir", "-o", help="Override output directory")
    ] = None,
    token: Annotated[
        str | None, typer.Option("--token", help="GitHub token (or env/gh CLI)")
    ] = None,
    public_only: Annotated[
        bool, typer.Option("--public-only", help="Only write the public export")
    ] = False,
    private_only: Annotated[
        bool, typer.Option("--private-only", help="Only write the private export")
    ] = False,
) -> None:
    """Fetch repository metadata and write JSON export files."""
    if public_only and private_only:
        err_console.print("--public-only and --private-only are mutually exclusive")
        raise typer.Exit(2)

    cfg = load_config(config)
    resolved = resolve_token(token)

    try:
        with GitHubClient(resolved) as client:
            written = run_export(
                client, cfg, out_dir=out_dir,
                public_only=public_only, private_only=private_only,
            )
    except GitHubClientError as e:
        err_console.print(f"[red]Export failed:[/red] {e}")
        raise typer.Exit(1) from e

    table = Table(title="github-export results")
    table.add_column("Output")
    table.add_column("Path")
    table.add_column("Repos", justify="right")
    for kind, path in written.items():
        data = json.loads(path.read_text())
        table.add_row(kind, str(path), str(data["stats"]["total"]))
        by_cat = data["stats"]["by_category"]
        table.add_row("", "  by category: " + ", ".join(
            f"{k}={v}" for k, v in sorted(by_cat.items())
        ), "")
    console.print(table)


@app.command()
def validate(
    file: Annotated[Path, typer.Argument(help="Export JSON file to validate")],
) -> None:
    """Validate an export file against the bundled JSON schema."""
    try:
        import jsonschema
    except ImportError:
        err_console.print("jsonschema is required: uv sync --group dev")
        raise typer.Exit(1) from None

    try:
        schema = json.loads(_schema_text())
        instance = json.loads(file.read_text())
    except (OSError, json.JSONDecodeError, FileNotFoundError) as e:
        err_console.print(f"[red]Cannot read {file}:[/red] {e}")
        raise typer.Exit(1) from e

    jsonschema.validate(instance, schema)
    console.print(f"[green]OK[/green] {file} conforms to schema {schema.get('$id', '')}")


@app.command()
def schema() -> None:
    """Print the JSON schema for the export contract to stdout."""
    try:
        console.print(_schema_text())
    except FileNotFoundError as e:
        err_console.print(f"[red]{e}[/red]")
        raise typer.Exit(1) from e
