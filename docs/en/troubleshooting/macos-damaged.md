# macOS Reports a Damaged App

macOS may report that SPlayer Together is damaged or cannot be checked for malicious software. This is usually Gatekeeper blocking an unsigned application downloaded outside the Mac App Store, not file corruption.

## Remove the quarantine attribute

Open Terminal and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/SPlayer Together.app
```

Enter your administrator password, then open the application again.

To remove all extended attributes instead:

```bash
sudo xattr -cr /Applications/SPlayer Together.app
```

You can also Control-click the app in Finder, choose **Open**, and confirm. This may need to be repeated.

## Apple Silicon

On an M-series Mac, prefer the ARM64 package. The x64 build may require Rosetta 2:

```bash
softwareupdate --install-rosetta --agree-to-license
```

## If it still fails

```bash
rm -rf /Applications/SPlayer Together.app
rm -rf ~/Library/Application\ Support/SPlayer Together
```

Download a fresh copy from [GitHub Releases](https://github.com/SPlayer-Dev/SPlayer-Next/releases), remove the quarantine attribute, and try again.
