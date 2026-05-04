$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$dir/shield-pre-tool.cjs"
exit $LASTEXITCODE
