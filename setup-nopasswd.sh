#!/bin/bash
USER=$(whoami)
echo "${USER} ALL=(ALL) NOPASSWD: /sbin/ifconfig" > /tmp/followfree
chmod 440 /tmp/followfree
SUDO_ASKPASS=$(pwd)/askpass.sh sudo -A cp /tmp/followfree /private/etc/sudoers.d/followfree
SUDO_ASKPASS=$(pwd)/askpass.sh sudo -A chown root:wheel /private/etc/sudoers.d/followfree
rm /tmp/followfree
