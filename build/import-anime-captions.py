"""Import an episode-named SRT ZIP into Watch Party's local caption library."""
import argparse
import json
from pathlib import Path
import re
import zipfile


def to_vtt(data):
    if data.startswith((b'\xff\xfe', b'\xfe\xff')):
        text = data.decode('utf-16')
    else:
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = data.decode('cp1252')
    blocks = re.split(r'\n\s*\n', text.replace('\r\n', '\n').replace('\r', '\n').strip())
    cues = []
    for block in blocks:
        lines = block.splitlines()
        if lines and lines[0].strip().isdigit():
            lines = lines[1:]
        if not lines or '-->' not in lines[0]:
            continue
        # Some downloaded "SRT" packs contain VTT-style dots, a three-digit
        # hour field, and settings joined directly to the end timestamp.
        stamp = r'(\d+):([0-5]\d):([0-5]\d)[.,](\d{3})'
        timing = re.match(r'^\s*' + stamp + r'\s+-->\s*' + stamp, lines[0])
        if not timing:
            # Broken exports sometimes contain negative-time intro cues rendered
            # as "-1 day" strings. Those cannot be reconstructed accurately.
            if re.search(r'0*-1 day,', lines[0]):
                continue
            raise ValueError('Invalid subtitle timestamp')
        fields = timing.groups()
        def clock(offset):
            h, m, s, ms = map(int, fields[offset:offset + 4])
            return f'{h:02}:{m:02}:{s:02}.{ms:03}'
        lines[0] = clock(0) + ' --> ' + clock(4)
        cues.append(re.sub(r'\{\\[^}]*\}', '', '\n'.join(lines)))
    if not cues:
        raise ValueError('No subtitle cues found')
    return 'WEBVTT\n\n' + '\n\n'.join(cues) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--anilist-id', type=int, required=True)
    parser.add_argument('--audio', choices=['dub', 'sub'], required=True)
    parser.add_argument('--language', default='en')
    args = parser.parse_args()
    if args.anilist_id < 1 or not re.fullmatch(r'[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*', args.language):
        parser.error('Invalid anime ID or subtitle language')
    root = Path(__file__).resolve().parents[1]
    folder = root / 'cache' / 'subtitles' / f'anime-{args.anilist_id}' / args.audio
    prepared = {}
    with zipfile.ZipFile(args.archive) as archive:
        if len(archive.infolist()) > 2000:
            raise ValueError('Too many archive entries')
        if sum(entry.file_size for entry in archive.infolist()) > 50_000_000:
            raise ValueError('Subtitle archive is too large')
        for entry in archive.infolist():
            if not entry.filename.lower().endswith('.srt'):
                continue
            match = re.search(r'\bS0*1E0*(\d+)\b', Path(entry.filename).name, re.I)
            if not match:
                continue
            episode = int(match[1])
            if not 1 <= episode <= 100000 or entry.file_size > 2_000_000:
                raise ValueError('Invalid episode or oversized caption file')
            if episode in prepared:
                raise ValueError(f'Ambiguous captions for episode {episode}')
            prepared[episode] = to_vtt(archive.read(entry))
    if not prepared:
        raise ValueError('No episode-named SRT files found')
    folder.mkdir(parents=True, exist_ok=True)
    for episode, text in prepared.items():
        (folder / f'{episode}.{args.language}.vtt').write_text(text, encoding='utf-8')
    print(json.dumps({'imported': len(prepared), 'first': min(prepared), 'last': max(prepared), 'folder': str(folder)}))


if __name__ == '__main__':
    main()
