# Google Drive ingress adapter

Implementation wave W2.

This module will observe the existing Drive structure but expose only `SourceObservation` to the domain. Folder names such as creator/week/day remain an interpreter configuration concern. Do not let Drive paths leak into publication scheduling code.
