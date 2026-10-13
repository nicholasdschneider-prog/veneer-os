#!/bin/zsh
R=/Users/archerclawdington/veneer-os; O=$R/out/build806-deploy-prep; B=$HOME/.local/share/veneer-pro-predeploy/build806-20261013
T=$(mktemp -d /tmp/b806-disp.XXXX); trap 'rm -rf $T' EXIT; umask 077
mkdir -p $T/data $T/old; cp $B/veneer-pro-online-20261013T213953Z.db $T/data/veneer-pro.db
shasum -a 256 $T/data/veneer-pro.db | cut -c1-64 | diff - <(cut -c1-64 $O/db-backup.sha256) >/dev/null && echo "copy matches backup hash"
P=$O/postcheck.sh; DB="file:$T/data/veneer-pro.db?immutable=1"
$P $DB > $B/disp-0-baseline.txt
open() { node --input-type=module -e "const m=await import('$1'); const db=m.openDb('$T/data'); console.log('openDb ok journal='+db.pragma('journal_mode',{simple:true})+' fk='+db.pragma('foreign_keys',{simple:true})); db.close();" 2>&1; echo "exit $?"; }
echo "--- A: live artifact (7a74def) openDb"; open $R/server/dist/db/db.js
$P $DB > $B/disp-A-forward.txt
tar xzf $B/rollback-1b8561a-dist.tgz -C $T/old; ln -s $R/node_modules $T/old/node_modules; ln -s $R/server/node_modules $T/old/server/node_modules
(cd $T/old && find server/dist web/dist -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) | diff -q - <(cat $O/manifest-rollback-server-dist.sha256 $O/manifest-rollback-web-dist.sha256) >/dev/null && echo "rollback bundle matches its manifests"
ls $T/old/server/dist/db/migrations | tail -2
echo "--- B: rollback candidate (1b8561a) openDb on migrated copy"; open $T/old/server/dist/db/db.js
echo "--- B2: rollback candidate openDb again"; open $T/old/server/dist/db/db.js
$P $DB > $B/disp-B-rollback.txt
echo "--- C: re-forward live artifact openDb"; open $R/server/dist/db/db.js
$P $DB > $B/disp-C-reforward.txt
chmod 600 $B/disp-*.txt
for s in 0-baseline A-forward B-rollback C-reforward; do grep '^## ' $B/disp-$s.txt > $O/disp-$s.hashes.txt; done
echo "--- diffs (hash lines)"; echo "0 vs A:"; diff $O/disp-0-baseline.hashes.txt $O/disp-A-forward.hashes.txt; echo "A vs B:"; diff $O/disp-A-forward.hashes.txt $O/disp-B-rollback.hashes.txt && echo identical; echo "B vs C:"; diff $O/disp-B-rollback.hashes.txt $O/disp-C-reforward.hashes.txt && echo identical
echo "--- A new objects/counts/migrations"; awk '/^## (migrations|new-schema|count|fk)/{p=1; print; next} /^## /{p=0} p' $B/disp-A-forward.txt
