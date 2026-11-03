//! Creating, unlocking and reading/writing a library (format spec §2–§13).

use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use dem_crypto::keys::{
    self, KdfParams, MasterKey, RecoveryCode, Subkeys, unwrap_with_password, unwrap_with_recovery,
};
use dem_crypto::{FileKey, envelope, records, stream};
use dem_model::{ItemId, ItemMeta, TypeDef};
use loro::ToJson;
use serde::{Deserialize, Serialize};

use crate::blobs::BlobName;
use crate::item::ItemDoc;
use crate::layout::{self, DeviceId, DocDir, FileKind};
use crate::logs::{LogKind, LogRecord, month_of};
use crate::manifest::Manifest;
use crate::structure::StructureDoc;
use crate::{Result, StoreError, atomic, io_err};

/// How to unlock a library.
pub enum Unlock<'a> {
    Password(&'a [u8]),
    Recovery(&'a RecoveryCode),
    /// The master key from the OS keychain (daily opening).
    MasterKey(MasterKey),
}

impl fmt::Debug for Unlock<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Unlock::Password(_) => "Unlock::Password",
            Unlock::Recovery(_) => "Unlock::Recovery",
            Unlock::MasterKey(_) => "Unlock::MasterKey",
        })
    }
}

#[derive(Serialize, Deserialize)]
struct DeviceFile {
    device: String,
}

struct SegmentState {
    header: [u8; records::HEADER_LEN],
    next_seq: u64,
}

/// An open, unlocked library. Holds the process lock until dropped.
pub struct Library {
    root: PathBuf,
    manifest: Manifest,
    master: MasterKey,
    keys: Subkeys,
    device: DeviceId,
    last_seq: AtomicU64,
    segments: Mutex<HashMap<String, SegmentState>>,
    _lock: File,
}

impl fmt::Debug for Library {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Library")
            .field("root", &self.root)
            .field("device", &self.device)
            .finish_non_exhaustive()
    }
}

fn lock(root: &Path) -> Result<File> {
    let path = root.join(layout::LOCK);
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(io_err(&path))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(fs::TryLockError::WouldBlock) => Err(StoreError::Locked),
        Err(fs::TryLockError::Error(e)) => Err(io_err(&path)(e)),
    }
}

impl Library {
    /// Creates a new library in an empty (or missing) directory. Returns the library and
    /// the recovery code, which must be shown to the user exactly once.
    pub fn create(
        root: &Path,
        password: &[u8],
        params: KdfParams,
    ) -> Result<(Library, RecoveryCode)> {
        if root.join(layout::MANIFEST).exists() {
            return Err(StoreError::AlreadyExists(root.display().to_string()));
        }
        fs::create_dir_all(root).map_err(io_err(root))?;
        if fs::read_dir(root).map_err(io_err(root))?.next().is_some() {
            return Err(StoreError::AlreadyExists(root.display().to_string()));
        }
        let lock_file = lock(root)?;

        let master = MasterKey::generate();
        let salt = keys::new_salt();
        let mut manifest = Manifest::new(uuid::Uuid::now_v7(), params, &salt);
        let pw = keys::wrap_with_password(
            &master,
            password,
            &salt,
            params,
            &manifest.password_binding()?,
        )?;
        manifest.set_wrapped("password", &pw);
        let code = RecoveryCode::generate();
        manifest.set_wrapped(
            "recovery",
            &keys::wrap_with_recovery(&master, &code, &manifest.recovery_binding()),
        );
        atomic::write(root, layout::MANIFEST, &manifest.to_json()?)?;

        let library = Library::assemble(root, manifest, master, lock_file)?;
        let mut structure = StructureDoc::create()?;
        library.save_structure(&mut structure)?;
        Ok((library, code))
    }

    /// Checks the master password without changing anything.
    pub fn check_password(&self, password: &[u8]) -> bool {
        let (Ok(wrapped), Ok(salt), Ok(binding)) = (
            self.manifest.wrapped("password"),
            self.manifest.salt(),
            self.manifest.password_binding(),
        ) else {
            return false;
        };
        unwrap_with_password(
            &wrapped,
            password,
            &salt,
            self.manifest.kdf_params(),
            &binding,
        )
        .is_ok()
    }

    /// Sets a new master password (after recovery, or a change). The key does not change, so
    /// nothing else has to be rewritten.
    pub fn set_password(&mut self, password: &[u8]) -> Result<()> {
        let salt = self.manifest.salt()?;
        let wrapped = keys::wrap_with_password(
            &self.master,
            password,
            &salt,
            self.manifest.kdf_params(),
            &self.manifest.password_binding()?,
        )?;
        self.manifest.set_wrapped("password", &wrapped);
        atomic::write(&self.root, layout::MANIFEST, &self.manifest.to_json()?)
    }

    /// Opens and unlocks an existing library.
    pub fn open(root: &Path, unlock: Unlock<'_>) -> Result<Library> {
        let mpath = root.join(layout::MANIFEST);
        let manifest = Manifest::parse(&fs::read(&mpath).map_err(io_err(&mpath))?)?;
        let lock_file = lock(root)?;
        let master = match unlock {
            Unlock::Password(pw) => unwrap_with_password(
                &manifest.wrapped("password")?,
                pw,
                &manifest.salt()?,
                manifest.kdf_params(),
                &manifest.password_binding()?,
            )?,
            Unlock::Recovery(code) => unwrap_with_recovery(
                &manifest.wrapped("recovery")?,
                code,
                &manifest.recovery_binding(),
            )?,
            Unlock::MasterKey(k) => k,
        };
        let library = Library::assemble(root, manifest, master, lock_file)?;
        // A key from the keychain is not checked by unwrapping; check it by reading.
        library.read_sealed(layout::DEVICE_FILE)?;
        Ok(library)
    }

    fn assemble(
        root: &Path,
        manifest: Manifest,
        master: MasterKey,
        lock_file: File,
    ) -> Result<Library> {
        let keys = Subkeys::derive(&master, &manifest.library_id_bytes());
        let mut library = Library {
            root: root.to_path_buf(),
            manifest,
            master,
            keys,
            device: DeviceId(0),
            last_seq: AtomicU64::new(0),
            segments: Mutex::new(HashMap::new()),
            _lock: lock_file,
        };
        // Leftovers of interrupted atomic writes.
        let tmp = root.join("tmp");
        if tmp.exists() {
            fs::remove_dir_all(&tmp).map_err(io_err(&tmp))?;
        }
        library.device = library.load_or_create_device()?;
        Ok(library)
    }

    fn load_or_create_device(&self) -> Result<DeviceId> {
        if self.root.join(layout::DEVICE_FILE).exists() {
            let bytes = self.read_sealed(layout::DEVICE_FILE)?;
            let d: DeviceFile = serde_json::from_slice(&bytes)
                .map_err(|e| StoreError::InvalidDocument(format!("device file: {e}")))?;
            let id = u64::from_str_radix(&d.device, 16)
                .map_err(|_| StoreError::InvalidDocument("device id".into()))?;
            return Ok(DeviceId(id));
        }
        let device = DeviceId(dem_crypto::random_u64());
        let json = serde_json::to_vec(&DeviceFile {
            device: device.to_string(),
        })
        .map_err(|e| StoreError::InvalidDocument(e.to_string()))?;
        self.write_sealed(layout::DEVICE_FILE, &json)?;
        Ok(device)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn device(&self) -> DeviceId {
        self.device
    }

    /// The master key, for storing in the OS keychain after a password unlock.
    pub fn master_key(&self) -> &MasterKey {
        &self.master
    }

    pub fn file_key(&self) -> &FileKey {
        &self.keys.files
    }

    pub fn index_key(&self) -> &dem_crypto::IndexKey {
        &self.keys.index
    }

    // ---- sealed small files -------------------------------------------------

    /// Reads and decrypts a small file (`.dexm`, `.dexu`, `local/*`).
    pub fn read_sealed(&self, rel: &str) -> Result<Vec<u8>> {
        let path = self.root.join(rel);
        let data = fs::read(&path).map_err(io_err(&path))?;
        Ok(envelope::open(&self.keys.files, rel, &data)?)
    }

    fn write_sealed(&self, rel: &str, plaintext: &[u8]) -> Result<()> {
        let sealed = envelope::seal(&self.keys.files, rel, plaintext)?;
        atomic::write(&self.root, rel, &sealed)
    }

    /// Never-decreasing sequence number for update files: Unix milliseconds, bumped
    /// within the same millisecond (format spec §2.1).
    /// A sequence number no other file of this device has.
    pub fn next_seq(&self) -> u64 {
        let now = u64::try_from(jiff::Timestamp::now().as_millisecond()).unwrap_or_default();
        let mut prev = self.last_seq.load(Ordering::Relaxed);
        loop {
            let next = now.max(prev + 1);
            match self
                .last_seq
                .compare_exchange(prev, next, Ordering::Relaxed, Ordering::Relaxed)
            {
                Ok(_) => return next,
                Err(p) => prev = p,
            }
        }
    }

    // ---- CRDT documents -----------------------------------------------------

    /// Snapshot first, then every update file of this document.
    fn doc_files(&self, dir: DocDir, stem: &str) -> Result<(Option<String>, Vec<String>)> {
        let parent_rel = dir.parent(stem);
        let parent = self.root.join(&parent_rel);
        let mut snapshot = None;
        let mut updates = Vec::new();
        if !parent.exists() {
            return Ok((None, updates));
        }
        for entry in fs::read_dir(&parent).map_err(io_err(&parent))? {
            let entry = entry.map_err(io_err(&parent))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = format!("{parent_rel}/{name}");
            match layout::classify(&rel) {
                FileKind::Snapshot { stem: s, .. } if s == stem => snapshot = Some(rel),
                FileKind::Update { stem: s, .. } if s == stem => updates.push(rel),
                _ => {}
            }
        }
        updates.sort();
        Ok((snapshot, updates))
    }

    fn read_doc_parts(&self, dir: DocDir, stem: &str) -> Result<(Vec<Vec<u8>>, Vec<String>)> {
        let (snapshot, updates) = self.doc_files(dir, stem)?;
        let snapshot = snapshot.ok_or_else(|| StoreError::NotFound(stem.to_string()))?;
        let mut parts = vec![self.read_sealed(&snapshot)?];
        for u in &updates {
            parts.push(self.read_sealed(u)?);
        }
        Ok((parts, updates))
    }

    /// Creates an item, writes its first snapshot and returns the open document.
    pub fn create_item(&self, meta: &ItemMeta) -> Result<ItemDoc> {
        let mut doc = ItemDoc::create(meta)?;
        let stem = layout::item_stem(&meta.id);
        self.write_sealed(&DocDir::Items.snapshot(&stem), &doc.export_snapshot()?)?;
        doc.mark_saved();
        Ok(doc)
    }

    pub fn load_item(&self, id: ItemId) -> Result<ItemDoc> {
        let (parts, _) = self.read_doc_parts(DocDir::Items, &layout::item_stem(&id))?;
        ItemDoc::load(id, &parts)
    }

    /// Writes committed but unsaved changes as one update file. Returns whether
    /// anything was written.
    pub fn save_item(&self, doc: &mut ItemDoc) -> Result<bool> {
        let Some(bytes) = doc.export_unsaved()? else {
            return Ok(false);
        };
        let rel = DocDir::Items.update(&layout::item_stem(&doc.id), self.device, self.next_seq());
        self.write_sealed(&rel, &bytes)?;
        doc.mark_saved();
        Ok(true)
    }

    /// Folds all update files into a new snapshot (format spec §8). Safe to
    /// interrupt at any point: leftover updates are re-imported idempotently.
    pub fn compact_item(&self, doc: &mut ItemDoc) -> Result<()> {
        let stem = layout::item_stem(&doc.id);
        let (parts, updates) = self.read_doc_parts(DocDir::Items, &stem)?;
        // Pick up updates written by others since this document was loaded.
        for p in &parts {
            doc.import(p)?;
        }
        self.write_sealed(&DocDir::Items.snapshot(&stem), &doc.export_snapshot()?)?;
        doc.mark_saved();
        for u in updates {
            let p = self.root.join(&u);
            fs::remove_file(&p).map_err(io_err(&p))?;
        }
        Ok(())
    }

    /// Ids of all items that have a snapshot.
    pub fn item_ids(&self) -> Result<Vec<ItemId>> {
        let dir = self.root.join("items");
        let mut ids = Vec::new();
        if !dir.exists() {
            return Ok(ids);
        }
        for shard in fs::read_dir(&dir).map_err(io_err(&dir))? {
            let shard = shard.map_err(io_err(&dir))?.path();
            if !shard.is_dir() {
                continue;
            }
            for f in fs::read_dir(&shard).map_err(io_err(&shard))? {
                let name = f
                    .map_err(io_err(&shard))?
                    .file_name()
                    .to_string_lossy()
                    .into_owned();
                if let Some(stem) = name.strip_suffix(".dexm")
                    && let Ok(id) = stem.parse::<ItemId>()
                {
                    ids.push(id);
                }
            }
        }
        ids.sort();
        Ok(ids)
    }

    /// Removes an item and every file of it, for good. The caller has asked first.
    pub fn delete_item(&self, id: ItemId) -> Result<()> {
        let stem = layout::item_stem(&id);
        let (snapshot, updates) = self.doc_files(DocDir::Items, &stem)?;
        for rel in snapshot.into_iter().chain(updates) {
            let p = self.root.join(&rel);
            fs::remove_file(&p).map_err(io_err(&p))?;
        }
        Ok(())
    }

    // ---- this device's own settings ----------------------------------------

    /// Reads a sealed file under `local/`. These do not sync; layouts and the like live here.
    pub fn read_local(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let rel = format!("local/{name}");
        if !self.root.join(&rel).exists() {
            return Ok(None);
        }
        self.read_sealed(&rel).map(Some)
    }

    pub fn write_local(&self, name: &str, bytes: &[u8]) -> Result<()> {
        self.write_sealed(&format!("local/{name}"), bytes)
    }

    // ---- type definitions (format spec §10) --------------------------------

    /// Writes a type's definition whole. Types change rarely and hold no content, so each
    /// change is one small update on the document.
    pub fn save_type(&self, def: &TypeDef) -> Result<()> {
        let stem = def.id.as_str();
        let (doc, saved_before) = match self.read_doc_parts(DocDir::Types, stem) {
            Ok((parts, _)) => {
                let doc = crate::item::new_doc();
                for p in &parts {
                    doc.import(p)?;
                }
                let vv = doc.oplog_vv();
                (doc, Some(vv))
            }
            Err(StoreError::NotFound(_)) => (crate::item::new_doc(), None),
            Err(e) => return Err(e),
        };
        doc.get_map("dem").insert("schema", crate::DOC_SCHEMA)?;
        let json =
            serde_json::to_string(def).map_err(|e| StoreError::InvalidDocument(e.to_string()))?;
        doc.get_map("def").insert("json", json)?;
        doc.set_next_commit_message("me");
        doc.commit();
        match saved_before {
            None => {
                let bytes = doc.export(loro::ExportMode::Snapshot)?;
                self.write_sealed(&DocDir::Types.snapshot(stem), &bytes)
            }
            Some(vv) => {
                let bytes = doc.export(loro::ExportMode::updates(&vv))?;
                self.write_sealed(
                    &DocDir::Types.update(stem, self.device, self.next_seq()),
                    &bytes,
                )
            }
        }
    }

    /// Every type definition in the library. One that cannot be read is skipped and logged,
    /// so it cannot stop the library opening.
    pub fn load_types(&self) -> Result<Vec<TypeDef>> {
        let dir = self.root.join("types");
        let mut stems = std::collections::BTreeSet::new();
        if dir.exists() {
            for shard in fs::read_dir(&dir).map_err(io_err(&dir))? {
                let shard = shard.map_err(io_err(&dir))?.path();
                if !shard.is_dir() {
                    continue;
                }
                for f in fs::read_dir(&shard).map_err(io_err(&shard))? {
                    let name = f
                        .map_err(io_err(&shard))?
                        .file_name()
                        .to_string_lossy()
                        .into_owned();
                    if let Some(stem) = name.strip_suffix(".dexm") {
                        stems.insert(stem.to_owned());
                    }
                }
            }
        }
        let mut out = Vec::new();
        for stem in stems {
            let (parts, _) = self.read_doc_parts(DocDir::Types, &stem)?;
            let doc = crate::item::new_doc();
            for p in &parts {
                doc.import(p)?;
            }
            let v = doc.get_map("def").get_deep_value().to_json_value();
            match v
                .get("json")
                .and_then(serde_json::Value::as_str)
                .map(serde_json::from_str::<TypeDef>)
            {
                Some(Ok(def)) => out.push(def),
                _ => tracing::warn!("type definition could not be read"),
            }
        }
        Ok(out)
    }

    pub fn load_structure(&self) -> Result<StructureDoc> {
        let (parts, _) = self.read_doc_parts(DocDir::Structure, layout::STRUCTURE_STEM)?;
        StructureDoc::load(&parts)
    }

    pub fn save_structure(&self, s: &mut StructureDoc) -> Result<()> {
        let stem = layout::STRUCTURE_STEM;
        if !self.root.join(DocDir::Structure.snapshot(stem)).exists() {
            let snap = s.doc.export(loro::ExportMode::Snapshot)?;
            self.write_sealed(&DocDir::Structure.snapshot(stem), &snap)?;
        } else if s.doc.oplog_vv() != s.saved {
            let bytes = s.doc.export(loro::ExportMode::updates(&s.saved))?;
            self.write_sealed(
                &DocDir::Structure.update(stem, self.device, self.next_seq()),
                &bytes,
            )?;
        }
        s.saved = s.doc.oplog_vv();
        Ok(())
    }

    // ---- logs ---------------------------------------------------------------

    /// Appends one record to this device's segment for the record's month.
    pub fn append_log(&self, kind: LogKind, record: &LogRecord) -> Result<()> {
        record.check()?;
        let rel = layout::log_segment(kind.as_str(), &month_of(record.ts), self.device);
        let path = self.root.join(&rel);
        let mut segments = self.segments.lock().map_err(|_| StoreError::Locked)?;
        if !segments.contains_key(&rel) {
            let state = self.open_segment_for_append(&rel)?;
            segments.insert(rel.clone(), state);
        }
        let Some(state) = segments.get_mut(&rel) else {
            return Err(StoreError::NotFound(rel));
        };
        let json =
            serde_json::to_vec(record).map_err(|e| StoreError::InvalidDocument(e.to_string()))?;
        let framed =
            records::seal_record(&self.keys.files, &state.header, &rel, state.next_seq, &json)?;
        let mut f = OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(io_err(&path))?;
        f.write_all(&framed).map_err(io_err(&path))?;
        f.sync_data().map_err(io_err(&path))?;
        state.next_seq += 1;
        Ok(())
    }

    fn open_segment_for_append(&self, rel: &str) -> Result<SegmentState> {
        let path = self.root.join(rel);
        if !path.exists() {
            let header = records::new_segment_header(&self.keys.files);
            atomic::write(&self.root, rel, &header)?;
            return Ok(SegmentState {
                header,
                next_seq: 0,
            });
        }
        let data = fs::read(&path).map_err(io_err(&path))?;
        let seg = records::open_segment(&self.keys.files, rel, &data)?;
        if seg.torn_tail_bytes > 0 {
            // Drop the half-written record left by a crash before appending.
            let f = OpenOptions::new()
                .write(true)
                .open(&path)
                .map_err(io_err(&path))?;
            f.set_len((data.len() - seg.torn_tail_bytes) as u64)
                .map_err(io_err(&path))?;
            f.sync_all().map_err(io_err(&path))?;
        }
        let mut header = [0u8; records::HEADER_LEN];
        header.copy_from_slice(&data[..records::HEADER_LEN]);
        Ok(SegmentState {
            header,
            next_seq: seg.records.len() as u64,
        })
    }

    /// Reads every record of one kind, across months and devices. Damaged records
    /// are counted, not returned.
    pub fn read_logs(&self, kind: LogKind) -> Result<LogRead> {
        let mut out = LogRead::default();
        for f in layout::scan(&self.root)? {
            let FileKind::LogSegment { kind: k, .. } = &f.kind else {
                continue;
            };
            if k != kind.as_str() {
                continue;
            }
            let path = self.root.join(&f.rel);
            let data = fs::read(&path).map_err(io_err(&path))?;
            let seg = records::open_segment(&self.keys.files, &f.rel, &data)?;
            out.torn_tail_bytes += seg.torn_tail_bytes;
            for r in seg.records {
                match r
                    .ok()
                    .and_then(|b| serde_json::from_slice::<LogRecord>(&b).ok())
                {
                    Some(rec) => out.records.push(rec),
                    None => out.damaged += 1,
                }
            }
        }
        out.records.sort_by_key(|r| r.ts);
        Ok(out)
    }

    // ---- attachments --------------------------------------------------------

    pub fn put_blob(&self, content: &[u8]) -> Result<BlobName> {
        let name = self.keys.blob_name.name_for(content)?;
        let rel = layout::blob_path(&name);
        if !self.root.join(&rel).exists() {
            let mut sealed = Vec::with_capacity(content.len() + content.len() / 4096 + 64);
            stream::seal(&self.keys.files, &rel, content, &mut sealed)?;
            atomic::write(&self.root, &rel, &sealed)?;
        }
        Ok(name)
    }

    /// Stores a file without loading it into memory (two passes: name, then data).
    pub fn put_blob_file(&self, src: &Path) -> Result<BlobName> {
        let name = self
            .keys
            .blob_name
            .name_for(File::open(src).map_err(io_err(src))?)?;
        let rel = layout::blob_path(&name);
        let target = self.root.join(&rel);
        if target.exists() {
            return Ok(name);
        }
        let tmp_dir = self.root.join("tmp");
        fs::create_dir_all(&tmp_dir).map_err(io_err(&tmp_dir))?;
        let tmp = tmp_dir.join(format!("{:016x}.tmp", dem_crypto::random_u64()));
        let out = File::create(&tmp).map_err(io_err(&tmp))?;
        let mut writer = std::io::BufWriter::new(out);
        stream::seal(
            &self.keys.files,
            &rel,
            File::open(src).map_err(io_err(src))?,
            &mut writer,
        )?;
        let out = writer
            .into_inner()
            .map_err(|e| io_err(&tmp)(e.into_error()))?;
        out.sync_all().map_err(io_err(&tmp))?;
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir).map_err(io_err(dir))?;
        }
        atomic::rename_with_retry(&tmp, &target).map_err(io_err(&target))?;
        Ok(name)
    }

    pub fn read_blob(&self, name: &str, out: impl Write) -> Result<u64> {
        let rel = layout::blob_path(name);
        let path = self.root.join(&rel);
        let f = File::open(&path).map_err(io_err(&path))?;
        Ok(stream::open(
            &self.keys.files,
            &rel,
            std::io::BufReader::new(f),
            out,
        )?)
    }

    /// Recomputes an attachment's name from its decrypted content (validator check).
    pub fn verify_blob(&self, name: &str) -> Result<bool> {
        let mut content = Vec::new();
        self.read_blob(name, &mut content)?;
        Ok(self.keys.blob_name.name_for(&content[..])? == name)
    }
}

/// Result of [`Library::read_logs`].
#[derive(Debug, Default)]
pub struct LogRead {
    pub records: Vec<LogRecord>,
    pub damaged: usize,
    pub torn_tail_bytes: usize,
}

/// Reads a whole file (used by tools to check envelopes without decrypting).
pub fn read_raw(root: &Path, rel: &str) -> Result<Vec<u8>> {
    let path = root.join(rel);
    let mut buf = Vec::new();
    File::open(&path)
        .map_err(io_err(&path))?
        .read_to_end(&mut buf)
        .map_err(io_err(&path))?;
    Ok(buf)
}
