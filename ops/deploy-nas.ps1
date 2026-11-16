param(
    [ValidateSet('all','web','wd14')][string]$Service='all',
    [string]$NasHost='10.147.18.102',
    [int]$SshPort=3322,
    [string]$NasUser='root',
    [string]$RemoteRoot='/vol1/1000/apps/prompt-lab',
    [string]$PythonPackageIndex='https://mirrors.aliyun.com/pypi/simple',
    [string]$ArtifactDirectory=(Join-Path $env:TEMP 'prompt-lab-deploy')
)
$ErrorActionPreference='Stop'
if($NasHost -notmatch '^[a-zA-Z0-9.-]+$' -or $NasUser -notmatch '^[a-zA-Z0-9_-]+$' -or $RemoteRoot -notmatch '^/vol[0-9]+/[a-zA-Z0-9_./-]+$' -or ($RemoteRoot -split '/') -contains '..') { throw 'Invalid deployment destination' }
if($PythonPackageIndex -notmatch '^https://[a-zA-Z0-9.-]+/[a-zA-Z0-9_./-]*$'){throw 'Invalid Python package index'}
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$services=if($Service -eq 'all'){@('wd14','web')}else{@($Service)}
$files=[Collections.Generic.List[string]]::new()
foreach($item in $services){
    $folder=Join-Path $repoRoot $item
    Get-ChildItem -LiteralPath $folder -File -Force | Where-Object {$_.Name -match '\.(js|mjs|py)$' -or $_.Name -in @('Dockerfile','.dockerignore','docker-compose.yml','package.json','package-lock.json','requirements.txt')} | ForEach-Object {$files.Add("$item/$($_.Name)")}
    if($item -eq 'web'){
        & git -C $repoRoot ls-files --cached --others --exclude-standard -- web/public | ForEach-Object {
            if(Test-Path -LiteralPath (Join-Path $repoRoot $_) -PathType Leaf){$files.Add($_)}
        }
        if($LASTEXITCODE -ne 0){throw 'Public asset inventory failed'}
    }
}
$files=@($files | Sort-Object)
$fingerprintText=($files | ForEach-Object {$_+' '+(Get-FileHash -LiteralPath (Join-Path $repoRoot $_)).Hash}) -join "`n"
$fingerprint=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($fingerprintText))).ToLowerInvariant()
$version='r-'+[DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyyMMddHHmmss')+'-'+$fingerprint.Substring(0,10)
$revision=(& git -C $repoRoot rev-parse HEAD).Trim()
if((& git -C $repoRoot status --porcelain)){ $revision+='-dirty' }
New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
$archive=Join-Path $ArtifactDirectory "$version.tar.gz"
& tar -czf $archive -C $repoRoot @files
if($LASTEXITCODE -ne 0){throw 'Source archive failed'}
$release="$RemoteRoot/.releases/$version"
$sshOptions=@('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=20','-p',"$SshPort")
$target="${NasUser}@${NasHost}"
& ssh @sshOptions $target "set -eu; test -d '$RemoteRoot'; umask 077; mkdir -p '$release'; test `"`$(readlink -f '$RemoteRoot')`" = '$RemoteRoot'; test `"`$(readlink -f '$release')`" = '$release'; chmod 700 '$release'"
if($LASTEXITCODE -ne 0){throw 'Remote staging failed'}
& scp -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -P $SshPort $archive "${target}:$release/incoming.tar.gz"
if($LASTEXITCODE -ne 0){throw 'Source upload failed'}
$metadata=[ordered]@{version=$version;revision=$revision;sourceSha256=$fingerprint;services=$services;files=$files;host=$NasHost;root=$RemoteRoot;pythonPackageIndex=$PythonPackageIndex}
$metadataPath=Join-Path $ArtifactDirectory "$version.json"
$metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metadataPath -Encoding utf8
& scp -o BatchMode=yes -o StrictHostKeyChecking=yes -P $SshPort $metadataPath "${target}:$release/source.json"
if($LASTEXITCODE -ne 0){throw 'Metadata upload failed'}
$remoteScript=@'
set -eu
root=$1
version=$2
revision=$3
services=$4
package_index=$5
release="$root/.releases/$version"
umask 077
printf '%s\n' "$root" > "$release/root.txt"
printf '%s\n' $services > "$release/services.txt"
: > "$release/previous-files.txt"
: > "$release/new-files.txt"
tar -tzf "$release/incoming.tar.gz" | while IFS= read -r file; do
  case "$file" in /*|../*|*/../*|*/..) echo 'Invalid archive entry' >&2; exit 1;; esac
  if [ -f "$root/$file" ]; then
    printf '%s\n' "$file" >> "$release/previous-files.txt"
  else
    printf '%s\n' "$file" >> "$release/new-files.txt"
  fi
done
tar -czf "$release/before-source.tar.gz" -C "$root" -T "$release/previous-files.txt"
for service in $services; do
  docker inspect "prompt-lab-$service" --format '{{.Image}}' > "$release/before-$service-image.txt"
  docker tag "$(cat "$release/before-$service-image.txt")" "prompt-lab-$service:rollback-$version"
done
# Protected configuration stays on the NAS; source updates never replace it.
tar -czf "$release/protected-config.tar.gz" -C "$root" web/config.json web/rules.json web/.env web/data
cat > "$release/restore-source.sh" <<'RESTORE'
#!/bin/sh
set -eu
release=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(cat "$release/root.txt")
test "$(readlink -f "$root")" = "$root"
tar -xzf "$release/before-source.tar.gz" -C "$root"
while IFS= read -r file; do
  case "$file" in /*|../*|*/../*|*/..) echo 'Invalid restore entry' >&2; exit 1;; esac
  resolved=$(readlink -m "$root/$file")
  case "$resolved" in "$root"/web/*|"$root"/wd14/*) ;; *) echo 'Restore path escaped project services' >&2; exit 1;; esac
  rm -f -- "$resolved"
done < "$release/new-files.txt"
RESTORE
chmod 700 "$release/restore-source.sh"
cat > "$release/rollback.sh" <<'ROLLBACK'
#!/bin/sh
set -eu
release=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(cat "$release/root.txt")
version=$(basename "$release")
sh "$release/restore-source.sh"
while IFS= read -r service; do
  previous=$(cat "$release/before-$service-image.txt")
  docker tag "$previous" "prompt-lab-$service:latest"
  cd "$root/$service"
  APP_VERSION="rollback-$version" docker compose up -d --no-build
done < "$release/services.txt"
ROLLBACK
chmod 700 "$release/rollback.sh"
switched=0
finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    if [ "$switched" -eq 1 ]; then
      echo 'Deployment failed; restoring previous source and images' >&2
      sh "$release/rollback.sh" || echo "Rollback requires attention: $release/rollback.sh" >&2
    else
      sh "$release/restore-source.sh"
    fi
  fi
  exit "$status"
}
trap finish EXIT
tar -xzf "$release/incoming.tar.gz" -C "$root"
tar -tzf "$release/incoming.tar.gz" | while IFS= read -r file; do
  if [ -f "$root/$file" ]; then chmod 644 "$root/$file"; fi
done
for service in $services; do
  cd "$root/$service"
  echo "Building $service $version"
  APP_VERSION="$version" VCS_REF="$revision" PYTHON_PACKAGE_INDEX="$package_index" docker compose build
done
switched=1
for service in $services; do
  cd "$root/$service"
  APP_VERSION="$version" VCS_REF="$revision" docker compose up -d --no-build
done
for service in $services; do
  attempts=0
  while [ "$(docker inspect "prompt-lab-$service" --format '{{.State.Health.Status}}')" != healthy ]; do
    attempts=$((attempts+1))
    if [ "$attempts" -ge 60 ]; then echo "Health check failed: $service" >&2; exit 1; fi
    sleep 5
  done
done
docker inspect prompt-lab-web prompt-lab-wd14 --format '{{.Name}}|image={{.Config.Image}}|health={{.State.Health.Status}}|restarts={{.RestartCount}}'
printf 'DEPLOYED %s\nROLLBACK sh %s/rollback.sh\n' "$version" "$release"
trap - EXIT
'@
$remoteScript=$remoteScript.Replace("`r`n","`n")
$remoteScript | & ssh @sshOptions $target "tr -d '\r' | sh -s -- '$RemoteRoot' '$version' '$revision' '$($services -join ' ')' '$PythonPackageIndex'"
if($LASTEXITCODE -ne 0){throw "Deployment failed; inspect $release"}
Write-Output "Release $version; metadata $metadataPath; rollback $release/rollback.sh"
