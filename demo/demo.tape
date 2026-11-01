Output demo/demo.gif

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 15
Set Width 1100
Set Height 720
Set Padding 18
Set Framerate 12
Set TypingSpeed 8ms
Set Theme "Catppuccin Mocha"

Type "node bin/vsx-diff.js compare demo/fixtures/goodpub.hello-1.0.0.vsix demo/fixtures/evilpub.hello-1.1.0.vsix --force-color"
Enter
Sleep 9s

Type "node bin/vsx-diff.js EditorConfig.EditorConfig --from 0.16.6 --to 0.18.2 --force-color --no-default-extension-dirs --cache-dir demo/.cache | head -n 28"
Enter
Sleep 8s
