#!/bin/zsh
# BUILD #814 fallback: no boot. Reconstructed 1b8561a openDb only, on a disposable copy of a fresh live backup that already holds 0178/0179.
R=/Users/archerclawdington/veneer-os; O=$R/out/build806-deploy-prep; B=$HOME/.local/share/veneer-pro-predeploy/build806-20261013
SRC=$1; [[ -f $SRC ]] || { echo "usage: $0 <backup.db>"; exit 2; }
T=$(mktemp -d /tmp/b814-disp.XXXX); trap 'rm -rf $T; echo "cleanup: removed $T"' EXIT; umask 077
mkdir -p $T/data $T/old; cp $SRC $T/data/veneer-pro.db
shasum -a 256 $T/data/veneer-pro.db | cut -c1-64 | diff - <(cut -c1-64 $SRC.sha256) >/dev/null && echo "copy matches backup hash" || { echo "BACKUP COPY HASH MISMATCH"; exit 1; }
P=$O/postcheck.sh; DB="file:$T/data/veneer-pro.db?immutable=1"
$P $DB > $B/disp-814-0-fresh.txt
echo "integrity: $(sqlite3 -readonly $DB 'pragma integrity_check' 2>&1 | head -3)"
open() { node --input-type=module -e "const m=await import('$1'); const db=m.openDb('$T/data'); console.log('openDb ok journal='+db.pragma('journal_mode',{simple:true})+' fk='+db.pragma('foreign_keys',{simple:true})+' migrations='+db.prepare('select count(*) n from migrations').get().n); db.close();" 2>&1; echo "exit $?"; }
shasum -a 256 -c $O/rollback-bundle.sha256 || exit 1
tar xzf $B/rollback-1b8561a-dist.tgz -C $T/old; ln -s $R/node_modules $T/old/node_modules; ln -s $R/server/node_modules $T/old/server/node_modules
(cd $T/old && find server/dist web/dist -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) | diff -q - <(cat $O/manifest-rollback-server-dist.sha256 $O/manifest-rollback-web-dist.sha256) >/dev/null && echo "rollback bundle matches its manifests" || { echo "MANIFEST MISMATCH"; exit 1; }
echo "bundle newest migrations: $(ls $T/old/server/dist/db/migrations | tail -2 | tr '\n' ' ')"
echo "--- B: reconstructed 1b8561a openDb on fresh live-state copy"; open $T/old/server/dist/db/db.js
echo "--- B2: again"; open $T/old/server/dist/db/db.js
$P $DB > $B/disp-814-B-rollback.txt
echo "integrity after: $(sqlite3 -readonly $DB 'pragma integrity_check' 2>&1 | head -3)"
chmod 600 $B/disp-814-*.txt
for s in 0-fresh B-rollback; do grep '^## ' $B/disp-814-$s.txt > $O/disp-814-$s.hashes.txt; done
echo "--- fresh vs B (hash lines):"; diff $O/disp-814-0-fresh.hashes.txt $O/disp-814-B-rollback.hashes.txt && echo identical
echo "--- fresh vs live pin after respawn (23:21:45Z):"; diff $O/pin-live-after-respawn-20261013T232145Z.hashes.txt $O/disp-814-0-fresh.hashes.txt && echo identical
echo "--- fresh vs 155b497 disposable forward (A):"; diff $O/disp-A-forward-155b497.hashes.txt $O/disp-814-0-fresh.hashes.txt && echo identical
echo "--- B migrations/new objects/counts/fk"; awk '/^## (migrations|new-schema|count|fk)/{p=1; print; next} /^## /{p=0} p' $B/disp-814-B-rollback.txt
