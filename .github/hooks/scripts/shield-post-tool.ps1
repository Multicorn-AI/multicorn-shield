$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$dir/shield-post-tool.cjs"
exit $LASTEXITCODE
