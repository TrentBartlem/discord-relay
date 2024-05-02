#! /usr/bin/env python3

from pathlib import Path
import click
import yaml
import json

devvit_file = Path("devvit.yaml")
package_json_file = Path("package.json")


@click.command()
@click.argument("bump_type", type=click.Choice(["major", "minor", "patch", "pre"]))
def main(bump_type):
    try:
        major, minor, patch, pre = get_version()
    except ValueError:
        major, minor, patch, pre = *get_version(), 0

    match bump_type:
        case "major":
            major += 1
            minor = 0
            patch = 0
            pre = 0
        case "minor":
            minor += 1
            patch = 0
            pre = 0
        case "patch":
            patch += 1
            pre = 0
        case "pre":
            pre += 1

    bump_version(f"{major}.{minor}.{patch}.{pre}")


def get_version():
    with devvit_file.open() as f:
        devvit = yaml.safe_load(f)

    return map(int, devvit["version"].split("."))


def bump_version(version):
    print(f"Bumping version to {version}")
    with package_json_file.open() as f:
        package_json = json.load(f)
        package_json["version"] = version
    with package_json_file.open("w") as f:
        json.dump(package_json, f, indent=2)


if __name__ == "__main__":
    main()
