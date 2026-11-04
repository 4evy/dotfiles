globals = { "Command", "cx", "ya" }

-- Rex injects its API into configuration modules
files["home/files/.config/rex/*.lua"] = {
  read_globals = { "rex" },
}
