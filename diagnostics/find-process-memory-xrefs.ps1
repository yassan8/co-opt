param(
    [Parameter(Mandatory = $true)]
    [string]$ProcessName,

    [Parameter(Mandatory = $true)]
    [string]$TargetAddress,

    [string]$StartRva = '0x0',

    [long]$Length = 0
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class XrefProcessMemoryReader
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

function Format-Bytes {
    param([byte[]]$Buffer, [int]$Start, [int]$Length)

    (($Buffer[$Start..($Start + $Length - 1)] | ForEach-Object { $_.ToString('X2') }) -join ' ')
}

function Find-RipRelativeReference {
    param([byte[]]$Buffer, [int]$Index, [int]$Length, [long]$InstructionAddress, [long]$Target)

    $cursor = $Index
    while ($cursor -lt $Length -and $cursor - $Index -lt 5) {
        $value = $Buffer[$cursor]
        if ($value -in @(0xF0, 0xF2, 0xF3, 0x2E, 0x36, 0x3E, 0x26, 0x64, 0x65, 0x66, 0x67) -or
            ($value -band 0xF0) -eq 0x40) {
            $cursor += 1
            continue
        }
        break
    }
    if ($cursor -ge $Length) { return $null }

    $opcode = $Buffer[$cursor]
    $cursor += 1
    $hasModRm = $opcode -in @(0x03, 0x0B, 0x13, 0x1B, 0x23, 0x2B, 0x33, 0x3B, 0x63, 0x69, 0x6B, 0x80, 0x81, 0x83, 0x89, 0x8B, 0x8D, 0xC6, 0xC7, 0xD1, 0xD3, 0xF6, 0xF7, 0xFF)
    if ($opcode -eq 0x0F) {
        if ($cursor -ge $Length) { return $null }
        $secondOpcode = $Buffer[$cursor]
        $cursor += 1
        $hasModRm = $secondOpcode -in @(0x10, 0x11, 0x28, 0x29, 0x2A, 0x2C, 0x2D, 0x54, 0x58, 0x59, 0x5C, 0x5D, 0x5E, 0x6E, 0x6F, 0x7E, 0x7F, 0xAF, 0xB6, 0xB7, 0xBE, 0xBF)
    }
    if (-not $hasModRm -or $cursor -ge $Length) { return $null }

    $modRm = $Buffer[$cursor]
    if (($modRm -band 0xC7) -ne 0x05 -or $cursor + 4 -ge $Length) { return $null }

    $displacement = [BitConverter]::ToInt32($Buffer, $cursor + 1)
    $instructionLength = ($cursor + 5) - $Index
    $resolved = $InstructionAddress + $instructionLength + $displacement
    if ($resolved -ne $Target) { return $null }

    [pscustomobject]@{
        Length = $instructionLength
        Opcode = if ($opcode -eq 0x0F) { '0F {0:X2}' -f $secondOpcode } else { '{0:X2}' -f $opcode }
    }
}

$process = Get-Process -Name $ProcessName -ErrorAction Stop | Select-Object -First 1
$module = $process.MainModule
$moduleStart = [long]$module.BaseAddress
$moduleEnd = $moduleStart + [long]$module.ModuleMemorySize
$scanStart = $moduleStart + [Convert]::ToInt64($StartRva.Replace('0x', ''), 16)
$scanEnd = if ($Length -gt 0) { [Math]::Min($scanStart + $Length, $moduleEnd) } else { $moduleEnd }
if ($scanStart -lt $moduleStart -or $scanStart -ge $moduleEnd -or $scanEnd -le $scanStart) {
    throw 'Requested scan range is outside the main module'
}
$target = [Convert]::ToInt64($TargetAddress.Replace('0x', ''), 16)
$targetBytes = [BitConverter]::GetBytes($target)
$handle = [XrefProcessMemoryReader]::OpenProcess(0x0410, $false, $process.Id)
if ($handle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$results = [Collections.Generic.List[object]]::new()
$address = $scanStart
$infoSize = [uint64][Runtime.InteropServices.Marshal]::SizeOf([type][XrefProcessMemoryReader+MEMORY_BASIC_INFORMATION])

try {
    while ($address -lt $scanEnd) {
        $info = New-Object XrefProcessMemoryReader+MEMORY_BASIC_INFORMATION
        $queried = [XrefProcessMemoryReader]::VirtualQueryEx(
            $handle,
            [IntPtr]$address,
            [ref]$info,
            [UIntPtr]::new($infoSize))
        if ($queried -eq [UIntPtr]::Zero) { break }

        $regionStart = [long]$info.BaseAddress
        $regionSize = [long]$info.RegionSize.ToUInt64()
        $regionEnd = [Math]::Min($regionStart + $regionSize, $scanEnd)
        $readable = $info.State -eq 0x1000 -and ($info.Protect -band 0x100) -eq 0 -and ($info.Protect -band 0x01) -eq 0

        if ($readable -and $regionEnd -gt $scanStart) {
            $readStart = [Math]::Max($regionStart, $scanStart)
            $length = [int]($regionEnd - $readStart)
            $buffer = New-Object byte[] $length
            $bytesRead = [UIntPtr]::Zero
            if ([XrefProcessMemoryReader]::ReadProcessMemory(
                $handle,
                [IntPtr]$readStart,
                $buffer,
                [UIntPtr]::new([uint64]$length),
                [ref]$bytesRead)) {
                $actualLength = [int]$bytesRead.ToUInt64()
                for ($index = 0; $index -le $actualLength - 8; $index++) {
                    $instructionAddress = $readStart + $index

                    $referenceParameters = @{
                        Buffer = $buffer
                        Index = $index
                        Length = $actualLength
                        InstructionAddress = $instructionAddress
                        Target = $target
                    }
                    $ripReference = Find-RipRelativeReference @referenceParameters
                    if ($null -ne $ripReference) {
                        $results.Add([pscustomobject]@{
                            Kind = "RIP-relative memory ($($ripReference.Opcode))"
                            Address = ('0x{0:X16}' -f $instructionAddress)
                            ModuleRva = ('0x{0:X}' -f ($instructionAddress - $moduleStart))
                            Bytes = Format-Bytes $buffer $index $ripReference.Length
                            Protection = ('0x{0:X}' -f $info.Protect)
                        })
                        $index += $ripReference.Length - 1
                        continue
                    }

                    $pointerMatches = $true
                    for ($byteIndex = 0; $byteIndex -lt 8; $byteIndex++) {
                        if ($buffer[$index + $byteIndex] -ne $targetBytes[$byteIndex]) {
                            $pointerMatches = $false
                            break
                        }
                    }
                    if ($pointerMatches) {
                        $results.Add([pscustomobject]@{
                            Kind = 'Absolute pointer'
                            Address = ('0x{0:X16}' -f $instructionAddress)
                            ModuleRva = ('0x{0:X}' -f ($instructionAddress - $moduleStart))
                            Bytes = Format-Bytes $buffer $index 8
                            Protection = ('0x{0:X}' -f $info.Protect)
                        })
                    }
                }
            }
        }

        $nextAddress = $regionStart + [Math]::Max(0x1000, $regionSize)
        if ($nextAddress -le $address) { break }
        $address = $nextAddress
    }
} finally {
    [void][XrefProcessMemoryReader]::CloseHandle($handle)
}

$results | ConvertTo-Json -Depth 3