# Regenerates sitemap.xml and data/games.js from data/games.json.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File tools\build-sitemap.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$origin = "https://arcadecampushub.online"
$today = (Get-Date).ToString("yyyy-MM-dd")

# Windows PowerShell's -Encoding utf8 always emits a BOM, which breaks JSON.parse
# for anything reading these files. Write through .NET with BOM suppressed instead.
$utf8 = New-Object System.Text.UTF8Encoding $false
function Write-Utf8([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, $script:utf8)
}

# Read through .NET as UTF-8. Get-Content -Raw defaults to the system ANSI
# codepage in Windows PowerShell, which decoded every non-ASCII byte wrongly
# and then wrote the damage back — so each run mangled the catalogue further.
$json = [System.IO.File]::ReadAllText((Join-Path $root "data\games.json"),
                                      [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
$games = $json | ConvertFrom-Json

# --- data/games.js (lets the catalog load over file:// with no fetch) ---
$header = "/* Auto-generated from data/games.json. Loaded as a plain script so the`r`n" +
          "   catalog works over file:// as well as http(s) with zero fetch latency. */`r`n"
Write-Utf8 (Join-Path $root "data\games.js") ($header + "window.GAME_CATALOG = " + $json.Trim() + ";`r`n")

# Normalise the source of truth too, in case it arrived with a BOM.
Write-Utf8 (Join-Path $root "data\games.json") $json

# --- sitemap.xml ---
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<?xml version="1.0" encoding="UTF-8"?>')
[void]$sb.AppendLine('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')

function Add-Url([string]$loc, [string]$priority, [string]$freq) {
  [void]$script:sb.AppendLine("  <url>")
  [void]$script:sb.AppendLine("    <loc>$loc</loc>")
  [void]$script:sb.AppendLine("    <lastmod>$script:today</lastmod>")
  [void]$script:sb.AppendLine("    <changefreq>$freq</changefreq>")
  [void]$script:sb.AppendLine("    <priority>$priority</priority>")
  [void]$script:sb.AppendLine("  </url>")
}

Add-Url "$origin/" "1.0" "daily"
Add-Url "$origin/browse.html" "0.9" "daily"
Add-Url "$origin/categories.html" "0.8" "weekly"
Add-Url "$origin/about.html" "0.4" "monthly"
Add-Url "$origin/support.html" "0.3" "monthly"
# login/signup are indexable entry points; the rest of the account area is not.
Add-Url "$origin/login.html" "0.3" "monthly"
Add-Url "$origin/signup.html" "0.3" "monthly"

foreach ($cat in ($games | Select-Object -ExpandProperty category -Unique | Sort-Object)) {
  Add-Url "$origin/browse.html?category=$cat" "0.7" "weekly"
}

foreach ($game in $games) {
  $id = [System.Uri]::EscapeDataString([string]$game.id)
  Add-Url "$origin/play.html?id=$id" "0.6" "monthly"
}

[void]$sb.AppendLine('</urlset>')
Write-Utf8 (Join-Path $root "sitemap.xml") $sb.ToString()

Write-Host ("Wrote sitemap.xml ({0} games) and data/games.js" -f $games.Count)
