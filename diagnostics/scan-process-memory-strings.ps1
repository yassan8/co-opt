param(
    [Parameter(Mandatory = $true)]
    [string]$ProcessName,

    [Parameter(Mandatory = $true)]
    [string[]]$Needle
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ProcessMemoryReader
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public UIntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(
        IntPtr process,
        IntPtr baseAddress,
        byte[] buffer,
        UIntPtr size,
        out UIntPtr bytesRead);

    [DllImport("kernel32.dll")]
    public static extern UIntPtr VirtualQueryEx(
        IntPtr process,
        IntPtr address,
        out MEMORY_BASIC_INFORMATION info,
        UIntPtr length);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

function Find-ByteSequence {
    param([byte[]]$Buffer, [byte[]]$Pattern, [int]$Length)

    for ($index = 0; $index -le $Length - $Pattern.Length; $index++) {
        $matches = $true
        for ($patternIndex = 0; $patternIndex -lt $Pattern.Length; $patternIndex++) {
            if ($Buffer[$index + $patternIndex] -ne $Pattern[$patternIndex]) {
                $matches = $false
                break
            }
        }
        if ($matches) { $index }
    }
}

$process = Get-Process -Name $ProcessName -ErrorAction Stop | Select-Object -First 1
$module = $process.MainModule
$moduleStart = [long]$module.BaseAddress
$moduleEnd = $moduleStart + [long]$module.ModuleMemorySize
$handle = [ProcessMemoryReader]::OpenProcess(0x0410, $false, $process.Id)
if ($handle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$patterns = foreach ($text in $Needle) {
    [pscustomobject]@{ Text = $text; Encoding = "ASCII"; Bytes = [Text.Encoding]::ASCII.GetBytes($text) }
    [pscustomobject]@{ Text = $text; Encoding = "UTF-16LE"; Bytes = [Text.Encoding]::Unicode.GetBytes($text) }
}

$results = [Collections.Generic.List[object]]::new()
$address = $moduleStart
$infoSize = [uint64][Runtime.InteropServices.Marshal]::SizeOf([type][ProcessMemoryReader+MEMORY_BASIC_INFORMATION])
$chunkSize = 1MB

try {
    while ($address -lt $moduleEnd) {
        $info = New-Object ProcessMemoryReader+MEMORY_BASIC_INFORMATION
        $queried = [ProcessMemoryReader]::VirtualQueryEx($handle, [IntPtr]$address, [ref]$info, [UIntPtr]::new($infoSize))
        if ($queried -eq [UIntPtr]::Zero) { break }

        $regionStart = [long]$info.BaseAddress
        $regionSize = [long]$info.RegionSize.ToUInt64()
        $regionEnd = [Math]::Min($regionStart + $regionSize, $moduleEnd)
        $readable = $info.State -eq 0x1000 -and ($info.Protect -band 0x100) -eq 0 -and ($info.Protect -band 0x01) -eq 0

        if ($readable) {
            for ($chunkStart = [Math]::Max($regionStart, $moduleStart); $chunkStart -lt $regionEnd; $chunkStart += $chunkSize) {
                $length = [int][Math]::Min($chunkSize, $regionEnd - $chunkStart)
                $buffer = New-Object byte[] $length
                $bytesRead = [UIntPtr]::Zero
                if ([ProcessMemoryReader]::ReadProcessMemory($handle, [IntPtr]$chunkStart, $buffer, [UIntPtr]::new([uint64]$length), [ref]$bytesRead)) {
                    $actualLength = [int]$bytesRead.ToUInt64()
                    foreach ($pattern in $patterns) {
                        foreach ($offset in Find-ByteSequence -Buffer $buffer -Pattern $pattern.Bytes -Length $actualLength) {
                            $results.Add([pscustomobject]@{
                                Text = $pattern.Text
                                Encoding = $pattern.Encoding
                                Address = ('0x{0:X16}' -f ($chunkStart + $offset))
                                ModuleRva = ('0x{0:X}' -f (($chunkStart + $offset) - $moduleStart))
                                Protection = ('0x{0:X}' -f $info.Protect)
                            })
                        }
                    }
                }
            }
        }

        $nextAddress = $regionStart + [Math]::Max(0x1000, $regionSize)
        if ($nextAddress -le $address) { break }
        $address = $nextAddress
    }
} finally {
    [void][ProcessMemoryReader]::CloseHandle($handle)
}

$results | ConvertTo-Json -Depth 3