$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$raw = [Console]::In.ReadToEnd()
$j = $raw | ConvertFrom-Json
$parts = @()

# Truecolor ANSI helpers (the Kitty theme the mods use, background #1d1d20)
$E = [char]27
function C($hex, $text, [switch]$Bold) {
    $r = [Convert]::ToInt32($hex.Substring(0,2),16)
    $g = [Convert]::ToInt32($hex.Substring(2,2),16)
    $b = [Convert]::ToInt32($hex.Substring(4,2),16)
    $pre = if ($Bold) { "$E[1m" } else { '' }
    "$pre$E[38;2;${r};${g};${b}m$text$E[0m"
}
$ORANGE = 'FF7800'; $BLUE = '62A0EA'; $PURPLE = 'DC8ADD'; $GREEN = '57E389'
$CYAN = '5BC8AF'; $AMBER = 'FFA348'; $RED = 'F66151'; $MUTED = '9A9996'

# Severity color for a percentage used; $calm is the color below 50%.
function Sev([double]$v, $calm) { if ($v -ge 80) { $RED } elseif ($v -ge 50) { $AMBER } else { $calm } }

# 1. Model and effort: "Opus 5.5 high"
$model = $j.model.display_name
if ($model) {
    $seg = ($model -replace '\s*\(.*$', '')
    $effort = $j.effort.level
    if ($effort) { $seg += " $effort" }
    $parts += C $ORANGE $seg
}

# 2. Repo name (branch), or the directory outside a repo
$cwd = $j.workspace.current_dir
if (-not $cwd) { $cwd = $j.cwd }
$repo = $j.workspace.repo.name
$branch = $null
$inRepo = $false
if ($cwd -and (Test-Path -LiteralPath $cwd)) {
    $top = git --no-optional-locks -C $cwd rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -eq 0 -and $top) {
        $inRepo = $true
        if (-not $repo) { $repo = Split-Path -Leaf $top }
        $branch = git --no-optional-locks -C $cwd branch --show-current 2>$null
        if (-not $branch) { $branch = $j.worktree.branch }
    }
}
if ($inRepo -and $repo) {
    $seg = C $BLUE $repo
    if ($branch) { $seg += ' ' + (C $PURPLE "($branch)") }
    $parts += $seg
} elseif ($cwd) {
    $parts += C $BLUE $cwd
}

# 3. Context: a 10-cell bar and the percentage used
$ctx = $j.context_window.used_percentage
if ($null -ne $ctx) {
    $u = [math]::Round([double]$ctx)
    $n = [math]::Min(10, [math]::Floor($u / 10))
    $bar = ([string][char]0x2588 * $n) + ([string][char]0x2591 * (10 - $n))
    $parts += C (Sev $u $GREEN) "$bar $u%"
}

# 4. 5-hour limit with the time to its reset, then the weekly limit
$five = $j.rate_limits.five_hour
if ($null -ne $five.used_percentage) {
    $v = [double]$five.used_percentage
    $t = "5h:{0:N0}%" -f $v
    if ($null -ne $five.resets_at) {
        $left = [int64]$five.resets_at - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        if ($left -gt 0) { $t += " reset:{0}h {1}m" -f [math]::Floor($left / 3600), [math]::Floor(($left % 3600) / 60) }
    }
    $parts += C (Sev $v $CYAN) $t
}
$week = $j.rate_limits.seven_day
if ($null -ne $week.used_percentage) {
    $v = [double]$week.used_percentage
    $parts += C (Sev $v $CYAN) ("wk:{0:N0}%" -f $v)
}

$sep = ' ' + (C $MUTED '|') + ' '
[Console]::Out.Write(($parts -join $sep))
