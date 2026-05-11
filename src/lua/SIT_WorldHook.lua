-- ============================================================================
-- SIT_WorldHook.lua - DCS SIT V6 World State Export
-- ============================================================================
-- Place dans : Saved Games\DCS\Scripts\Hooks\SIT_WorldHook.lua
-- Remplace SIT_AmmoHook.lua sur le serveur (ne pas avoir les deux en même temps)
--
-- Exporte :
--   1. Worldstate : toutes les unités sol/air des deux coalitions
--   2. Ammo + vie des joueurs (comme SIT_AmmoHook)
--   3. Messages SIT → DCS (trigger.action.outText)
--   4. Ordres d'unités (WP, ROE, formation)
-- ============================================================================

local SIT = {}
SIT.worldPath = lfs.writedir() .. [[Logs\sit_worldstate.json]]
SIT.playersPath = lfs.writedir() .. [[Logs\sit_players.json]]
SIT.msgPath = lfs.writedir() .. [[Logs\sit_multi_msg.json]]
SIT.orderPath = lfs.writedir() .. [[Logs\sit_unit_order.json]]
SIT.settingsPath = lfs.writedir() .. [[Logs\sit_unit_settings.json]]
SIT.smokePath = lfs.writedir() .. [[Logs\sit_smoke.json]]
SIT.jfoPath = lfs.writedir() .. [[Logs\sit_jfo_request.json]]
SIT.refaltPath = lfs.writedir() .. [[Logs\sit_refalt_request.json]]
SIT.evasanEventsPath = lfs.writedir() .. [[Logs\sit_evasan_events.json]]
SIT.evasanOrderPath = lfs.writedir() .. [[Logs\sit_evasan_order.json]]
SIT.spawn105Path = lfs.writedir() .. [[Logs\sit_spawn105.json]]
SIT.spawnCSARPath = lfs.writedir() .. [[Logs\sit_spawn_csar.json]]
SIT.modsStatusPath = lfs.writedir() .. [[Logs\sit_mods_status.json]]
SIT.ravitoOrderPath = lfs.writedir() .. [[Logs\sit_ravito_order.json]]
SIT.ravitoEventsPath = lfs.writedir() .. [[Logs\sit_ravito_events.json]]
SIT.lastEvasanOrderTs = 0
SIT.lastSpawn105Ts = 0
SIT.evasanTrackedCrashes = {} -- [crashId] = true to avoid duplicates
SIT.xlCurrentSlot = 0 -- persistent slot counter to avoid DCS crashes on duplicate IDs
SIT.modsChecked = false
SIT.modsAvailable = {} -- { modpack = true, dam = true, kap = true }
SIT.refaltPending = false
SIT.refaltLat = 0
SIT.refaltLon = 0
SIT.updateInterval = 2.0
SIT.ownInterval = 0.2 -- V8: own vehicle telemetry refresh (5 Hz) for responsive compass/DDM
SIT.lastOwnUpdate = 0
SIT.lastUpdate = 0
SIT.logCount = 0
SIT.env = nil
SIT.calibrated = false
SIT.calibRefX = nil
SIT.calibRefZ = nil
SIT.trackedPlayers = {}
SIT.lastMsgTimestamp = 0
SIT.lastOrderTimestamp = 0
SIT.lastSettingsTimestamp = 0
SIT.udpSocket = nil
SIT.UDP_HOST = "127.0.0.1"
SIT.UDP_PORT = 9089 -- worldstate UDP (9088 = bridge Export.lua)

-- ============================================================================
-- CALLBACKS
-- ============================================================================
local SIT_Callbacks = {}

function SIT_Callbacks.onPlayerConnect(id)
    pcall(function()
        local name = net.get_name(id)
        if name then
            SIT.trackedPlayers[id] = { name = name, slot = "" }
            log.write("SIT_World", log.INFO, "Player connected: id=" .. id .. " name=" .. name)
        end
    end)
end

function SIT_Callbacks.onPlayerDisconnect(id)
    if SIT.trackedPlayers[id] then
        log.write("SIT_World", log.INFO, "Player disconnected: " .. (SIT.trackedPlayers[id].name or "?"))
        SIT.trackedPlayers[id] = nil
    end
end

function SIT_Callbacks.onPlayerChangeSlot(id)
    pcall(function()
        local name = net.get_name(id)
        local slotId = net.get_slot(id)
        if name then
            SIT.trackedPlayers[id] = { name = name, slot = slotId or "" }
        end
    end)
end

function SIT_Callbacks.onSimulationStop()
    log.write("SIT_World", log.INFO, "=== Mission stopping — resetting state ===")
    SIT.env = nil
    SIT.calibrated = false
    SIT.calibRefX = nil
    SIT.calibRefZ = nil
    SIT.logCount = 0
    SIT.lastUpdate = 0
    SIT.lastOwnUpdate = 0
    SIT.evasanBootstrapped = false
    -- Don't clear trackedPlayers - players stay connected across missions
    -- Don't clear udpSocket - it persists
end

-- V10: also wipe state when a new mission starts (most reliable callback on dedicated servers)
function SIT_Callbacks.onSimulationStart()
    log.write("SIT_World", log.INFO, "=== Simulation started — reset for new mission ===")
    SIT.env = nil
    SIT.calibrated = false
    SIT.calibRefX = nil
    SIT.calibRefZ = nil
    SIT.logCount = 0
    SIT.lastUpdate = 0
    SIT.lastOwnUpdate = 0
    SIT.evasanBootstrapped = false
    SIT.ownLogCount = 0
    -- Signal multi server only if socket exists and was used previously (avoid spurious resets at very first start)
    if SIT.udpSocket and SIT.everSent then
        pcall(function()
            SIT.sendUDP("M", '{"event":"missionReset","timestamp":' .. os.time() .. '}')
        end)
        log.write("SIT_World", log.INFO, "missionReset signal sent (onSimulationStart)")
    end
end

function SIT_Callbacks.onMissionLoadEnd()
    log.write("SIT_World", log.INFO, "=== New mission loaded — resetting env ===")
    SIT.env = nil
    SIT.calibrated = false
    SIT.calibRefX = nil
    SIT.calibRefZ = nil
    SIT.logCount = 0
    -- V10: re-bootstrap event handlers in the fresh mission env
    SIT.evasanBootstrapped = false
    SIT.ownLogCount = 0
    -- V10: signal mission reset to the multi server so it broadcasts to all clients
    if SIT.udpSocket then
        pcall(function()
            SIT.sendUDP("M", '{"event":"missionReset","timestamp":' .. os.time() .. '}')
        end)
        log.write("SIT_World", log.INFO, "missionReset signal sent to multi server")
    end
end

-- ============================================================================
-- MAIN FRAME
-- ============================================================================
function SIT_Callbacks.onSimulationFrame()
    local ok1, now = pcall(DCS.getModelTime)
    if not ok1 or not now then return end
    
    -- V10: detect mission time reset — DCS.getModelTime resets to 0 (or low) when a new mission
    -- loads. If `now` is significantly lower than the previous tick's time, the mission has changed.
    -- This is more reliable than onMissionLoadEnd, which doesn't always fire on dedicated servers.
    if SIT.lastUpdate > 0 and now < SIT.lastUpdate - 1.0 then
        log.write("SIT_World", log.INFO, "=== Mission time reset detected (was " .. SIT.lastUpdate .. ", now " .. now .. ") — broadcasting missionReset ===")
        SIT.env = nil
        SIT.calibrated = false
        SIT.calibRefX = nil
        SIT.calibRefZ = nil
        SIT.logCount = 0
        SIT.evasanBootstrapped = false
        SIT.ownLogCount = 0
        SIT.lastUpdate = 0
        SIT.lastOwnUpdate = 0
        if SIT.udpSocket then
            pcall(function()
                SIT.sendUDP("M", '{"event":"missionReset","timestamp":' .. os.time() .. '}')
            end)
        end
    end
    
    -- V8: fast-path for ownVehicle (5 Hz). Runs independently of the 2s main loop so the
    -- compass, DDM, and vehicle telemetry stay responsive without flooding the worldstate.
    local ownDue = (now - SIT.lastOwnUpdate) >= SIT.ownInterval
    local mainDue = (now - SIT.lastUpdate) >= SIT.updateInterval
    if not ownDue and not mainDue then return end
    if ownDue then SIT.lastOwnUpdate = now end
    if mainDue then SIT.lastUpdate = now end
    
    -- Détecter l'environnement
    if not SIT.env then
        local ok1, r1 = pcall(net.dostring_in, 'server', 'return "ok"')
        if ok1 and r1 == "ok" then
            SIT.env = 'server'
        else
            local ok2, r2 = pcall(net.dostring_in, 'mission', 'return "ok"')
            SIT.env = (ok2 and r2 == "ok") and 'mission' or 'server'
        end
        log.write("SIT_World", log.INFO, "Using env: " .. SIT.env)
        
        -- Init UDP socket (only if not already created)
        if not SIT.udpSocket then
            pcall(function()
                local socket = require("socket")
                SIT.udpSocket = socket.udp()
                SIT.udpSocket:settimeout(0)
                log.write("SIT_World", log.INFO, "UDP socket created -> " .. SIT.UDP_HOST .. ":" .. SIT.UDP_PORT)
            end)
            if not SIT.udpSocket then
                log.write("SIT_World", log.WARNING, "UDP socket FAILED - using file fallback")
            end
        end
    end
    
    -- ================================================================
    -- MAIN SLOW PATH (2s interval): messages, orders, worldstate, EVASAN, mods, etc.
    -- ================================================================
    if mainDue then
    
    -- ================================================================
    -- 1. MESSAGES SIT → DCS
    -- ================================================================
    pcall(function()
        local mf = io.open(SIT.msgPath, "r")
        if not mf then return end
        local content = mf:read("*a")
        mf:close()
        if not content or #content < 5 then return end
        os.remove(SIT.msgPath)
        
        -- File may contain multiple JSON messages (JSONL) appended since last tick
        for line in content:gmatch('[^\r\n]+') do
            if #line >= 10 then
                local ts = tonumber(line:match('"timestamp":(%d+)'))
                if ts and ts > SIT.lastMsgTimestamp then
                    SIT.lastMsgTimestamp = ts
                    local author = line:match('"author":"([^"]*)"') or "SIT"
                    local text = line:match('"text":"([^"]*)"') or ""
                    local coalition = line:match('"coalition":"([^"]*)"') or "all"
                    local duration = tonumber(line:match('"duration":(%d+)')) or 60
                    
                    if text ~= "" then
                        local displayMsg = "[SIT] " .. author .. ": " .. text
                        local safeMsg = displayMsg:gsub("'", "\\'"):gsub('"', '\\"'):gsub("\n", " ")
                        
                        local outCode
                        if coalition == "blue" then
                            outCode = string.format("trigger.action.outTextForCoalition(coalition.side.BLUE, '%s', %d)", safeMsg, duration)
                        elseif coalition == "red" then
                            outCode = string.format("trigger.action.outTextForCoalition(coalition.side.RED, '%s', %d)", safeMsg, duration)
                        else
                            outCode = string.format("trigger.action.outText('%s', %d)", safeMsg, duration)
                        end
                        
                        pcall(net.dostring_in, SIT.env, outCode)
                        log.write("SIT_World", log.INFO, "MSG: [" .. coalition .. "] " .. displayMsg)
                    end
                end
            end
        end
    end)
    
    -- ================================================================
    -- 2. ORDRES D'UNITÉS
    -- ================================================================
    pcall(function()
        local of = io.open(SIT.orderPath, "r")
        if not of then return end
        local content = of:read("*a")
        of:close()
        if not content or #content < 5 then return end
        os.remove(SIT.orderPath)
        
        -- JSONL: one JSON order per line
        for line in content:gmatch('[^\r\n]+') do
            if #line >= 5 then
            local unitName = line:match('"unitName":"([^"]*)"') or ""
            local speed = tonumber(line:match('"speed":([%d%.]+)')) or 30
            local formation = line:match('"formation":"([^"]*)"') or "off_road"
            local roe = line:match('"roe":"([^"]*)"') or "free"
            
            local waypoints = {}
            for lat, lon in line:gmatch('"lat":([%-]?[%d%.]+).-"lon":([%-]?[%d%.]+)') do
                table.insert(waypoints, {lat=tonumber(lat), lon=tonumber(lon)})
            end
            
            local orderType = line:match('"order":"([^"]*)"') or "route"
            
            if unitName ~= "" and orderType == "stop" then
                local safeUnit = unitName:gsub("'", "\\'")
                local stopCode = string.format([[
                    local r = "err"
                    pcall(function()
                        local u = Unit.getByName('%s')
                        if u and Unit.isExist(u) then
                            local g = Unit.getGroup(u)
                            if g then g:getController():setTask({id='Hold',params={}}) r = "ok" end
                        end
                    end)
                    return r
                ]], safeUnit)
                pcall(net.dostring_in, SIT.env, stopCode)
                log.write("SIT_World", log.INFO, "ORDER: STOP " .. unitName)
            elseif unitName ~= "" and #waypoints > 0 then
        
        local safeUnit = unitName:gsub("'", "\\'")
        local speedMs = speed / 3.6
        -- DCS formation: set via waypoint `action` string + setOption/setCommand for robustness
        local action = "Off Road"
        local formVal = 8
        if formation == "on_road" then action = "On Road"; formVal = 4
        elseif formation == "rank" or formation == "line_abreast" then action = "Rank"; formVal = 17
        elseif formation == "cone" then action = "Cone"; formVal = 1
        elseif formation == "diamond" then action = "Diamond"; formVal = 12
        elseif formation == "vee" then action = "Vee"; formVal = 11
        elseif formation == "echelon_left" then action = "Echelon Left"; formVal = 5
        elseif formation == "echelon_right" then action = "Echelon Right"; formVal = 6
        end
        
        local roeCode = "AI.Option.Ground.val.ROE.OPEN_FIRE"
        if roe == "hold" then roeCode = "AI.Option.Ground.val.ROE.WEAPON_FREE"
        elseif roe == "return" then roeCode = "AI.Option.Ground.val.ROE.RETURN_FIRE"
        end
        
        -- Apply formation via BOTH setCommand and setOption (redundant for reliability)
        local formCode = string.format([[
            pcall(function() controller:setCommand({id='Option', params={name=5, value=%d}}) end)
            pcall(function() controller:setOption(5, %d) end)
        ]], formVal, formVal)
        -- Same but uses variable 'c' instead of 'controller' (for scheduled re-apply)
        local formCodeC = string.format([[
            pcall(function() c:setCommand({id='Option', params={name=5, value=%d}}) end)
            pcall(function() c:setOption(5, %d) end)
        ]], formVal, formVal)
        
        local coordCode = ""
        for i, wp in ipairs(waypoints) do
            coordCode = coordCode .. string.format("local p%d=coord.LLtoLO(%.10f,%.10f,0)\nlocal dx%d,dz%d=p%d.x,p%d.z\n", i, wp.lat, wp.lon, i, i, i, i)
        end
        
        local wpCode = "{"
        wpCode = wpCode .. "[1]={action='" .. action .. "',x=curPos.x,y=curPos.z,speed=" .. speedMs .. ",type='Turning Point'},"
        for i = 1, #waypoints do
            wpCode = wpCode .. string.format("[%d]={action='%s',x=dx%d,y=dz%d,speed=%f,type='Turning Point'},", i+1, action, i, i, speedMs)
        end
        wpCode = wpCode .. "}"
        
        local orderCode = string.format([[
            local result = "error"
            pcall(function()
                local unit = Unit.getByName('%s')
                if not unit or not Unit.isExist(unit) then result = "unit_not_found" return end
                local grp = Unit.getGroup(unit)
                if not grp then result = "no_group" return end
                local curPos = unit:getPoint()
                %s
                local route = %s
                local controller = grp:getController()
                controller:setOption(AI.Option.Ground.id.ROE, %s)
                %s
                controller:setTask({id='Mission',params={route={points=route}}})
                -- Re-apply formation after task (some formations activate only when moving)
                %s
                -- Schedule another formation re-apply 3 sec after task starts
                local grpName = grp:getName()
                timer.scheduleFunction(function()
                    local g = Group.getByName(grpName)
                    if g and Group.isExist(g) then
                        local c = g:getController()
                        if c then %s end
                    end
                end, nil, timer.getTime() + 3)
                result = "ok"
            end)
            return result
        ]], safeUnit, coordCode, wpCode, roeCode, formCode, formCode, formCodeC)
        
        local ok2, result = pcall(net.dostring_in, SIT.env, orderCode)
        log.write("SIT_World", log.INFO, "ORDER: " .. unitName .. " " .. #waypoints .. " WPs speed=" .. speed .. " roe=" .. roe .. " result=" .. tostring(result))
            end -- end elseif route
            end -- end line >= 5
        end -- end for each line
    end)
    
    -- ================================================================
    -- 3. SETTINGS D'UNITÉS (ROE/vitesse sans route)
    -- ================================================================
    pcall(function()
        local sf = io.open(SIT.settingsPath, "r")
        if not sf then return end
        local content = sf:read("*a")
        sf:close()
        if not content or #content < 5 then return end
        os.remove(SIT.settingsPath)
        
        for line in content:gmatch('[^\r\n]+') do
            if #line >= 5 then
            local unitName = line:match('"unitName":"([^"]*)"') or ""
            local roe = line:match('"roe":"([^"]*)"') or "free"
            local speed = tonumber(line:match('"speed":([%d%.]+)')) or 30
            local formation = line:match('"formation":"([^"]*)"') or "off_road"
            if unitName ~= "" then
        
            local roeCode = "AI.Option.Ground.val.ROE.OPEN_FIRE"
            if roe == "hold" then roeCode = "AI.Option.Ground.val.ROE.WEAPON_FREE"
            elseif roe == "return" then roeCode = "AI.Option.Ground.val.ROE.RETURN_FIRE"
            end
            
            -- Formation (numeric values for reliability)
            local formVal = nil
            if formation == "off_road" then formVal = 8
            elseif formation == "on_road" then formVal = 4
            elseif formation == "rank" or formation == "line_abreast" then formVal = 17
            elseif formation == "cone" then formVal = 1
            elseif formation == "diamond" then formVal = 12
            elseif formation == "vee" then formVal = 11
            elseif formation == "echelon_left" then formVal = 5
            elseif formation == "echelon_right" then formVal = 6
            end
            local formCode = ""
            if formVal then
                formCode = string.format([[
                    pcall(function() controller:setCommand({id='Option', params={name=5, value=%d}}) end)
                    pcall(function() controller:setOption(5, %d) end)
                ]], formVal, formVal)
            end
        
        local safeUnit = unitName:gsub("'", "\\'")
        local code = string.format([[
            local result = "error"
            pcall(function()
                local unit = Unit.getByName('%s')
                if not unit then result = "unit_not_found" return end
                local grp = Unit.getGroup(unit)
                if not grp then result = "no_group" return end
                local controller = grp:getController()
                controller:setOption(AI.Option.Ground.id.ROE, %s)
                %s
                result = "ok"
            end)
            return result
        ]], safeUnit, roeCode, formCode)
        
        pcall(net.dostring_in, SIT.env, code)
        log.write("SIT_World", log.INFO, "SETTINGS: " .. unitName .. " roe=" .. roe .. " form=" .. formation)
            end -- end unitName check
            end -- end line >= 5
        end -- end for each line
    end)
    
    -- ================================================================
    -- 3b. FUMIGÈNES (trigger.action.smoke)
    -- ================================================================
    pcall(function()
        local sf = io.open(SIT.smokePath, "r")
        if not sf then return end
        local content = sf:read("*a")
        sf:close()
        if not content or #content < 5 then return end
        
        -- Parser le tableau JSON manuellement
        -- Format: [{"lat":X,"lon":X,"color":N,"author":"X","timestamp":N},...]
        local smokes = {}
        for lat, lon, color in content:gmatch('"lat":([%-]?[%d%.]+).-"lon":([%-]?[%d%.]+).-"color":(%d+)') do
            table.insert(smokes, {lat=tonumber(lat), lon=tonumber(lon), color=tonumber(color)})
        end
        
        if #smokes == 0 then os.remove(SIT.smokePath) return end
        
        for _, smoke in ipairs(smokes) do
            local smokeCode = string.format([[
                pcall(function()
                    local pos = coord.LLtoLO(%.10f, %.10f, 0)
                    pos.y = land.getHeight({x=pos.x, y=pos.z}) + 1
                    trigger.action.smoke(pos, %d)
                end)
            ]], smoke.lat, smoke.lon, smoke.color)
            pcall(net.dostring_in, SIT.env, smokeCode)
        end
        
        log.write("SIT_World", log.INFO, "SMOKE: " .. #smokes .. " fumigène(s) déclenché(s)")
        os.remove(SIT.smokePath)
    end)
    
    -- ================================================================
    -- 3c. JFO (Joint Fires Observer — artillery fire order via marker)
    -- ================================================================
    pcall(function()
        local jf = io.open(SIT.jfoPath, "r")
        if not jf then return end
        local content = jf:read("*a")
        jf:close()
        if not content or #content < 5 then return end
        os.remove(SIT.jfoPath)
        
        local group = content:match('"group":"([^"]+)"')
        local lat = tonumber(content:match('"lat":([%-]?[%d%.]+)'))
        local lon = tonumber(content:match('"lon":([%-]?[%d%.]+)'))
        local weapon = content:match('"weapon":"([^"]+)"') or "auto"
        local shots = tonumber(content:match('"shots":(%d+)')) or 6
        local radius = tonumber(content:match('"radius":(%d+)')) or 0
        
        if not group or not lat or not lon then
            log.write("SIT_World", log.WARNING, "JFO: invalid request")
            return
        end
        
        log.write("SIT_World", log.INFO, "JFO: group=" .. group .. " weapon=" .. weapon .. " shots=" .. shots .. " radius=" .. radius)
        
        -- Pre-compute adjusted values based on weapon type (same logic as JFO.lua)
        local special = "nil"
        local smokeColor = "nil"
        local alt = 0
        local adjShots = shots
        local adjRadius = radius
        local weaponType = 1073741822
        
        if weapon == "gun" then weaponType = 268435456
        elseif weapon == "rockets" then weaponType = 30720
        elseif weapon == "lacm" then weaponType = 2097152
            if adjShots > 3 then adjShots = 3 end
        elseif weapon == "smoke" then
            special = '"SMOKE"'; adjShots = 6; alt = 0
        elseif weapon == "smoke green" then
            special = '"SMOKE COLOR"'; smokeColor = "0"; adjShots = 1; alt = 0
        elseif weapon == "smoke red" then
            special = '"SMOKE COLOR"'; smokeColor = "1"; adjShots = 1; alt = 0
        elseif weapon == "smoke orange" then
            special = '"SMOKE COLOR"'; smokeColor = "3"; adjShots = 1; alt = 0
        elseif weapon == "smoke blue" then
            special = '"SMOKE COLOR"'; smokeColor = "4"; adjShots = 1; alt = 0
        elseif weapon == "flare" then
            special = '"FLARE"'; alt = 1000; adjShots = 1
        elseif weapon == "mines" then
            special = '"MINES"'; alt = 0
            if adjShots > 7 then adjShots = 7 end
            if adjRadius == 0 then adjRadius = 40 end
        elseif weapon == "cluster" then
            special = '"CLUSTER"'; alt = 0
            if adjShots > 3 then adjShots = 3 end
            if adjRadius == 0 then adjRadius = 70 end
        end
        
        -- Step 1: FireAtPoint via SIT.env
        local isSpecial = (special ~= "nil")
        local fireCode
        
        if not isSpecial then
            -- Standard ammo: just FireAtPoint
            fireCode = string.format([[
                local result = "?"
                pcall(function()
                    local grp = Group.getByName("%s")
                    if not grp then grp = Group.getByName(string.lower("%s")) end
                    if not grp then grp = Group.getByName(string.upper("%s")) end
                    if not grp then
                        local tc = string.lower("%s")
                        tc = tc:sub(1,1):upper() .. tc:sub(2)
                        grp = Group.getByName(tc)
                    end
                    -- V14: full case-insensitive scan across all coalition groups.
                    -- Lets the user type "MaRTel" / "MARTEL" / "martel" interchangeably.
                    if not grp then
                        local target = string.lower("%s")
                        for _, side in ipairs({coalition.side.BLUE, coalition.side.RED, coalition.side.NEUTRAL}) do
                            for _, cat in ipairs({Group.Category.GROUND, Group.Category.AIRPLANE, Group.Category.HELICOPTER, Group.Category.SHIP}) do
                                local grps = coalition.getGroups(side, cat)
                                if grps then
                                    for _, g in ipairs(grps) do
                                        if g and Group.isExist(g) then
                                            local gname = Group.getName(g) or ""
                                            if string.lower(gname) == target then
                                                grp = g
                                                break
                                            end
                                        end
                                    end
                                end
                                if grp then break end
                            end
                            if grp then break end
                        end
                    end
                    if not grp then result = "ERR:group not found" return end
                    
                    grp:getController():setOnOff(false)
                    grp:getController():setOnOff(true)
                    grp:getController():setTask({id = 'FireAtPoint', params = {
                        x = pos.x, y = pos.z, altitude = pos.y,
                        radius = %d, expendQty = %d,
                        alt_type = 0, expendQtyEnabled = true, weaponType = %d
                    }})
                    
                    result = "OK:" .. grp:getName()
                end)
                return result
            ]], group, group, group, group, group, lat, lon, alt, adjRadius, adjShots, weaponType)
        else
            -- Special ammo: fire 1 token shot + spawn effect directly
            -- Special ammo: NO FireAtPoint, just timer + spawn effect
            local effectCode = ""
            if weapon == "smoke" then
                -- JFO-style tactical smoke: dispersed points, preset 8, density 0.5
                -- Each shot = 1 smoke point, 90s lifetime, 2s refresh
                -- + anti-LOS cylinder per point
                effectCode = string.format([[
                    -- Init global smoke LOS registry
                    if not _SIT_SMK then
                        _SIT_SMK = { active = {}, guardOn = false }
                    end
                    
                    local numShots = %d
                    local radius = math.max(%d, 150)
                    
                    for s = 1, numShots do
                        local r = math.sqrt(math.random()) * radius
                        local theta = math.random() * 6.2832
                        local sx = tgtPos.x + r * math.cos(theta)
                        local sz = tgtPos.z + r * math.sin(theta)
                        local sy = land.getHeight({x=sx, y=sz})
                        local pt = {x=sx, y=sy, z=sz}
                        
                        local baseName = "sit_smk_" .. tostring(math.random(1,99999999))
                        local count = 0
                        local lifetime = 90
                        local smokeLife = 2
                        local interval = 2
                        local tEnd = timer.getTime() + delay + lifetime
                        
                        -- Register LOS blocking volume (cylinder 20m radius, 80m height)
                        _SIT_SMK.active[#_SIT_SMK.active+1] = {x=pt.x, y=pt.y, z=pt.z, r=20, h=80, expire=tEnd}
                        
                        local function loop(_, timeNow)
                            if timeNow >= tEnd then return end
                            count = count + 1
                            local name = baseName .. "_" .. count
                            trigger.action.effectSmokeBig(pt, 8, 0.5, name)
                            timer.scheduleFunction(function(n) pcall(trigger.action.effectSmokeStop, n) end, name, timeNow + smokeLife)
                            return timeNow + interval
                        end
                        timer.scheduleFunction(loop, {}, timer.getTime() + delay + s * 0.5)
                    end
                    
                    -- Anti-LOS fire guard
                    if not _SIT_SMK.guardOn then
                        _SIT_SMK.guardOn = true
                        local ROE_ID = AI.Option.Ground.id.ROE
                        local ROE_HOLD = AI.Option.Ground.val.ROE.WEAPON_HOLD
                        local ROE_OPEN = AI.Option.Ground.val.ROE.OPEN_FIRE
                        local holdUntil = {}
                        
                        local function distPtSeg(P, A, B)
                            local vx, vz = B.x-A.x, B.z-A.z
                            local len2 = vx*vx + vz*vz
                            if len2 < 0.01 then return math.sqrt((P.x-A.x)^2 + (P.z-A.z)^2) end
                            local t = ((P.x-A.x)*vx + (P.z-A.z)*vz) / len2
                            if t < 0 then t = 0 elseif t > 1 then t = 1 end
                            local dx, dz = P.x-(A.x+t*vx), P.z-(A.z+t*vz)
                            return math.sqrt(dx*dx + dz*dz)
                        end
                        
                        local function fireGuard(_, timeNow)
                            local j = 1
                            for i = 1, #_SIT_SMK.active do
                                if _SIT_SMK.active[i].expire > timeNow then
                                    if i ~= j then _SIT_SMK.active[j] = _SIT_SMK.active[i] end
                                    j = j + 1
                                end
                            end
                            for k = j, #_SIT_SMK.active do _SIT_SMK.active[k] = nil end
                            
                            if #_SIT_SMK.active == 0 then
                                for uid, _ in pairs(holdUntil) do
                                    pcall(function()
                                        local u = Unit.getByName(uid)
                                        if u and Unit.isExist(u) then u:getController():setOption(ROE_ID, ROE_OPEN) end
                                    end)
                                end
                                _SIT_SMK.guardOn = false
                                return
                            end
                            
                            for _, side in ipairs({coalition.side.RED, coalition.side.BLUE}) do
                                local groups = coalition.getGroups(side, Group.Category.GROUND)
                                if groups then
                                    for _, g in ipairs(groups) do
                                        local units = g:getUnits()
                                        if units then
                                            for _, u in ipairs(units) do
                                                if u and Unit.isExist(u) then
                                                    local uid = u:getName()
                                                    if holdUntil[uid] and timeNow >= holdUntil[uid] then
                                                        pcall(function() u:getController():setOption(ROE_ID, ROE_OPEN) end)
                                                        holdUntil[uid] = nil
                                                    end
                                                    local up = u:getPoint()
                                                    local otherSide = (side == coalition.side.RED) and coalition.side.BLUE or coalition.side.RED
                                                    local eGroups = coalition.getGroups(otherSide, Group.Category.GROUND)
                                                    if eGroups then
                                                        for _, eg in ipairs(eGroups) do
                                                            local eu = eg:getUnits()
                                                            if eu then
                                                                for _, e in ipairs(eu) do
                                                                    if e and Unit.isExist(e) then
                                                                        local ep = e:getPoint()
                                                                        if (ep.x-up.x)^2+(ep.z-up.z)^2 < 100000000 then
                                                                            for si = 1, #_SIT_SMK.active do
                                                                                local S = _SIT_SMK.active[si]
                                                                                if distPtSeg({x=S.x,z=S.z}, up, ep) <= (S.r or 20) then
                                                                                    pcall(function() u:getController():setOption(ROE_ID, ROE_HOLD) end)
                                                                                    holdUntil[uid] = timeNow + 2
                                                                                    break
                                                                                end
                                                                            end
                                                                        end
                                                                    end
                                                                end
                                                            end
                                                        end
                                                    end
                                                end
                                            end
                                        end
                                    end
                                end
                            end
                            return timeNow + 1
                        end
                        timer.scheduleFunction(fireGuard, {}, timer.getTime() + delay + 2)
                    end
                ]], adjShots, adjRadius)
            elseif weapon:sub(1,5) == "smoke" then
                -- Colored smoke marker
                effectCode = string.format([[
                    timer.scheduleFunction(function()
                        trigger.action.smoke(tgtPos, %s)
                    end, nil, timer.getTime() + delay)
                ]], smokeColor)
            elseif weapon == "flare" then
                effectCode = [[
                    timer.scheduleFunction(function()
                        trigger.action.illuminationBomb(tgtPos, 1000000)
                    end, nil, timer.getTime() + delay)
                ]]
            elseif weapon == "mines" then
                effectCode = string.format([[
                    local country = grp:getCountry()
                    local mShots = %d
                    local mRadius = %d
                    for sh = 1, mShots do
                        timer.scheduleFunction(function()
                            trigger.action.explosion(tgtPos, 1)
                            for i = 1, 9 do
                                local mx = tgtPos.x + math.random(-mRadius,mRadius)
                                local mz = tgtPos.z + math.random(-mRadius,mRadius)
                                coalition.addStaticObject(country, {
                                    heading=0, shape_name="Landmine", type="Landmine",
                                    rate=100, name="sit_mine_"..tostring(math.random(1,99999999)),
                                    category="Fortification", y=mz, x=mx, dead=false
                                })
                            end
                        end, nil, timer.getTime() + delay + (sh-1)*3)
                    end
                ]], adjShots, adjRadius)
            elseif weapon == "cluster" then
                effectCode = string.format([[
                    local cShots = %d
                    local cRadius = %d
                    for sh = 1, cShots do
                        timer.scheduleFunction(function()
                            for i = 1, 25 do
                                local cx = tgtPos.x + math.random(-cRadius,cRadius)
                                local cz = tgtPos.z + math.random(-cRadius,cRadius)
                                local cy = land.getHeight({x=cx,y=cz}) + 1
                                timer.scheduleFunction(function()
                                    trigger.action.explosion({x=cx,y=cy,z=cz}, math.random(1,2))
                                end, nil, timer.getTime() + i*0.1)
                            end
                        end, nil, timer.getTime() + delay + (sh-1)*5)
                    end
                ]], adjShots, adjRadius)
            end
            
            fireCode = string.format([[
                local result = "?"
                pcall(function()
                    local grp = Group.getByName("%s")
                    if not grp then grp = Group.getByName(string.lower("%s")) end
                    if not grp then grp = Group.getByName(string.upper("%s")) end
                    if not grp then
                        local tc = string.lower("%s")
                        tc = tc:sub(1,1):upper() .. tc:sub(2)
                        grp = Group.getByName(tc)
                    end
                    if not grp then
                        local target = string.lower("%s")
                        for _, side in ipairs({coalition.side.BLUE, coalition.side.RED, coalition.side.NEUTRAL}) do
                            for _, cat in ipairs({Group.Category.GROUND, Group.Category.AIRPLANE, Group.Category.HELICOPTER, Group.Category.SHIP}) do
                                local grps = coalition.getGroups(side, cat)
                                if grps then
                                    for _, g in ipairs(grps) do
                                        if g and Group.isExist(g) then
                                            local gname = Group.getName(g) or ""
                                            if string.lower(gname) == target then grp = g break end
                                        end
                                    end
                                end
                                if grp then break end
                            end
                            if grp then break end
                        end
                    end
                    if not grp then result = "ERR:group not found" return end
                    
                    local tgtPos = coord.LLtoLO(%.10f, %.10f, 0)
                    tgtPos.y = land.getHeight({x = tgtPos.x, y = tgtPos.z}) + %d
                    
                    -- NO FireAtPoint for special ammo
                    -- Base delay 45s + flight time (~500 m/s)
                    local artPos = grp:getUnits()[1]:getPoint()
                    local dist = math.sqrt((artPos.x-tgtPos.x)^2 + (artPos.z-tgtPos.z)^2)
                    local delay = 45 + dist / 500
                    
                    -- Spawn special effect
                    %s
                    
                    result = "OK:" .. grp:getName() .. ":special"
                end)
                return result
            ]], group, group, group, group, group, lat, lon, alt, effectCode)
        end
        
        local ok, result = pcall(net.dostring_in, SIT.env, fireCode)
        log.write("SIT_World", log.INFO, "JFO fire: " .. tostring(result))
    end)
    
    -- ================================================================
    -- 3d. REFALT (elevation grid sampling)
    -- ================================================================
    pcall(function()
        local rf = io.open(SIT.refaltPath, "r")
        if not rf then return end
        local content = rf:read("*a")
        rf:close()
        if not content or #content < 5 then return end
        
        local lat = tonumber(content:match('"lat":([%-]?[%d%.]+)'))
        local lon = tonumber(content:match('"lon":([%-]?[%d%.]+)'))
        local rLat = tonumber(content:match('"refLat":([%-]?[%d%.]+)'))
        local rLon = tonumber(content:match('"refLon":([%-]?[%d%.]+)'))
        if not lat or not lon then os.remove(SIT.refaltPath) return end
        
        os.remove(SIT.refaltPath)
        log.write("SIT_World", log.INFO, "REFALT: center=" .. lat .. "," .. lon .. " ref=" .. tostring(rLat) .. "," .. tostring(rLon))
        
        -- 1. Compute DCS-relative SIT coordinates for center (and map corners if provided)
        local sitExtra = ""
        if rLat and rLon then
            local coordCode = string.format([[
                local r = ""
                pcall(function()
                    local cp = coord.LLtoLO(%.10f, %.10f, 0)
                    local rp = coord.LLtoLO(%.10f, %.10f, 0)
                    -- 2x2 transformation matrix: SIT coords → lat/lon
                    local lat0, lon0 = coord.LOtoLL({x=rp.x, y=0, z=rp.z})
                    local latA, lonA = coord.LOtoLL({x=rp.x+10000, y=0, z=rp.z})
                    local latB, lonB = coord.LOtoLL({x=rp.x, y=0, z=rp.z+10000})
                    -- latPerY = dlat when moving 1m in SIT Y (DCS X), etc.
                    local latPerY = (latA - lat0) / 10000
                    local latPerX = (latB - lat0) / 10000
                    local lonPerY = (lonA - lon0) / 10000
                    local lonPerX = (lonB - lon0) / 10000
                    r = string.format(
                        '"sitX":%%.2f,"sitY":%%.2f,"latPerY":%%.12f,"latPerX":%%.12f,"lonPerY":%%.12f,"lonPerX":%%.12f,"dcsRefLat":%%.10f,"dcsRefLon":%%.10f',
                        cp.z - rp.z, cp.x - rp.x, latPerY, latPerX, lonPerY, lonPerX, lat0, lon0)
                end)
                return r
            ]], lat, lon, rLat, rLon)
            local ok2, coords = pcall(net.dostring_in, SIT.env, coordCode)
            if ok2 and coords and #coords > 5 then
                sitExtra = "," .. coords
                log.write("SIT_World", log.INFO, "REFALT: DCS coords computed: " .. coords)
            end
        end
        
        -- Map corners (if provided)
        local mapLat = tonumber(content:match('"mapLat":([%-]?[%d%.]+)'))
        local mapLon = tonumber(content:match('"mapLon":([%-]?[%d%.]+)'))
        local mapWKm = tonumber(content:match('"mapWKm":([%-]?[%d%.]+)'))
        local mapHKm = tonumber(content:match('"mapHKm":([%-]?[%d%.]+)'))
        if mapLat and mapLon and mapWKm and mapHKm and rLat and rLon then
            local mapCode = string.format([[
                local r = ""
                pcall(function()
                    local rp = coord.LLtoLO(%.10f, %.10f, 0)
                    local tl = coord.LLtoLO(%.10f, %.10f, 0)
                    local wm = %.2f * 1000
                    local hm = %.2f * 1000
                    local tlx,tlz = tl.z-rp.z, tl.x-rp.x
                    local trx,try_ = tlx+wm, tlz
                    local blx,bly = tlx, tlz-hm
                    local brx,bry = tlx+wm, tlz-hm
                    r = string.format(
                        '"mapTL":[%%.2f,%%.2f],"mapTR":[%%.2f,%%.2f],"mapBL":[%%.2f,%%.2f],"mapBR":[%%.2f,%%.2f]',
                        tlx, tlz, trx, try_, blx, bly, brx, bry)
                end)
                return r
            ]], rLat, rLon, mapLat, mapLon, mapWKm, mapHKm)
            local ok3, mapCoords = pcall(net.dostring_in, SIT.env, mapCode)
            if ok3 and mapCoords and #mapCoords > 5 then
                sitExtra = sitExtra .. "," .. mapCoords
                log.write("SIT_World", log.INFO, "REFALT: map 4 corners computed")
            end
        end
        
        -- 2. Sample 100x100 altitude grid at 500m step (±25km = 50km)
        local code = string.format([[
            local a = {}
            pcall(function()
                local p = coord.LLtoLO(%.10f, %.10f, 0)
                for r = -50, 49 do
                    for c = -50, 49 do
                        a[#a+1] = tostring(math.floor(land.getHeight({x=p.x+r*500, y=p.z+c*500})+0.5))
                    end
                end
            end)
            return table.concat(a, ',')
        ]], lat, lon)
        
        local ok, raw = pcall(net.dostring_in, SIT.env, code)
        if ok and raw and #raw > 10 then
            local header = string.format('{"lat":%.10f,"lon":%.10f,"step":500,"size":100,"tier":"fine"%s,"alt":[', lat, lon, sitExtra)
            local payload = header .. raw .. ']}'
            log.write("SIT_World", log.INFO, "REFALT (fine): " .. #payload .. " bytes, sending")
            SIT.sendUDP("E", payload)
        else
            log.write("SIT_World", log.WARNING, "REFALT (fine): FAILED ok=" .. tostring(ok) .. " len=" .. tostring(raw and #raw or "nil"))
        end
        
        -- 3. V8: second pass, coarse grid covering ±100km (200x200km) at 2000m step.
        -- Same number of samples (100x100 = 10k) so the payload weight is comparable, but covers
        -- 16x the area. Used by the client as fallback when terrain elevation is queried outside
        -- the fine grid's 50x50km range.
        local code2 = string.format([[
            local a = {}
            pcall(function()
                local p = coord.LLtoLO(%.10f, %.10f, 0)
                for r = -50, 49 do
                    for c = -50, 49 do
                        a[#a+1] = tostring(math.floor(land.getHeight({x=p.x+r*2000, y=p.z+c*2000})+0.5))
                    end
                end
            end)
            return table.concat(a, ',')
        ]], lat, lon)
        local ok2, raw2 = pcall(net.dostring_in, SIT.env, code2)
        if ok2 and raw2 and #raw2 > 10 then
            local header2 = string.format('{"lat":%.10f,"lon":%.10f,"step":2000,"size":100,"tier":"coarse","alt":[', lat, lon)
            local payload2 = header2 .. raw2 .. ']}'
            log.write("SIT_World", log.INFO, "REFALT (coarse): " .. #payload2 .. " bytes, sending")
            SIT.sendUDP("E", payload2)
        else
            log.write("SIT_World", log.WARNING, "REFALT (coarse): FAILED ok=" .. tostring(ok2) .. " len=" .. tostring(raw2 and #raw2 or "nil"))
        end
    end)
    
    -- ================================================================
    -- 4. AMMO + VIE DES JOUEURS
    -- ================================================================
    pcall(function()
        local playerNames = {}
        for pid, pinfo in pairs(SIT.trackedPlayers) do
            if pinfo.name and pinfo.slot and pinfo.slot ~= "" and pinfo.slot ~= "observer" then
                playerNames[pinfo.name] = true
            end
        end
        if not next(playerNames) then return end
        
        local nameList = ""
        for pn in pairs(playerNames) do
            local safeName = pn:gsub("'", "\\'"):gsub('"', '\\"')
            if nameList ~= "" then nameList = nameList .. "," end
            nameList = nameList .. '"' .. safeName .. '"'
        end
        
        local code = [[
            local wanted = {]] .. nameList .. [[}
            local wantedSet = {}
            for _, n in ipairs(wanted) do wantedSet[n] = true end
            local results = {}
            pcall(function()
                for _, coaSide in ipairs({coalition.side.BLUE, coalition.side.RED}) do
                    local groups = coalition.getGroups(coaSide, Group.Category.GROUND)
                    if groups then
                        for _, grp in ipairs(groups) do
                            if grp and Group.isExist(grp) then
                                local units = Group.getUnits(grp)
                                if units then
                                    for _, u in ipairs(units) do
                                        if u and Unit.isExist(u) then
                                            local pn = Unit.getPlayerName(u)
                                            if pn and wantedSet[pn] then
                                                local ammoStr = "[]"
                                                local lifeStr = "-1"
                                                pcall(function()
                                                    local life = u:getLife()
                                                    local life0 = u:getLife0()
                                                    if life0 and life0 > 0 and life then
                                                        lifeStr = tostring(math.floor(life/life0*100+0.5))
                                                    end
                                                end)
                                                pcall(function()
                                                    local ammo = Unit.getAmmo(u)
                                                    if ammo and #ammo > 0 then
                                                        local parts = {}
                                                        for _, a in ipairs(ammo) do
                                                            local name = a.desc and (a.desc.displayName or a.desc.typeName) or "Unknown"
                                                            name = name:gsub('\\','\\\\'):gsub('"','\\"')
                                                            parts[#parts+1] = string.format('{"name":"%s","count":%d}', name, a.count or 0)
                                                        end
                                                        if #parts > 0 then ammoStr = '[' .. table.concat(parts,',') .. ']' end
                                                    end
                                                end)
                                                local safeName = pn:gsub('\\','\\\\'):gsub('"','\\"')
                                                results[#results+1] = string.format('"%s":{"ammo":%s,"life":%s}', safeName, ammoStr, lifeStr)
                                                wantedSet[pn] = nil
                                            end
                                        end
                                    end
                                end
                            end
                        end
                    end
                end
            end)
            if #results > 0 then return '{' .. table.concat(results,',') .. '}' end
            return '{}'
        ]]
        
        local ok, raw = pcall(net.dostring_in, SIT.env, code)
        if ok and raw and #raw > 2 then
            if not SIT.sendUDP("P", raw) then
                local f = io.open(SIT.playersPath, "w")
                if f then f:write(raw); f:close() end
            end
        end
    end)
    
    -- ================================================================
    -- 5. WORLDSTATE : TOUTES LES UNITÉS
    -- ================================================================
    pcall(function()
        local code = [[
            local results = {}
            pcall(function()
                for _, coaSide in ipairs({coalition.side.BLUE, coalition.side.RED}) do
                    local coaName = coaSide == coalition.side.BLUE and "blue" or "red"
                    
                    -- Unités sol
                    local groups = coalition.getGroups(coaSide, Group.Category.GROUND)
                    if groups then
                        for _, grp in ipairs(groups) do
                            if grp and Group.isExist(grp) then
                                local units = Group.getUnits(grp)
                                if units then
                                    for _, u in ipairs(units) do
                                        -- V8: filter out delayed-activation units. They satisfy Unit.isExist
                                        -- but haven't been activated yet (start_time in the future, or trigger
                                        -- not yet fired). Use Unit:isActive() when available; otherwise use the
                                        -- velocity/position fallback (active units have a real getPoint).
                                        local active = false
                                        if u and Unit.isExist(u) then
                                            local hasIsActive, isAct = pcall(function() return u:isActive() end)
                                            if hasIsActive and isAct ~= nil then
                                                active = isAct
                                            else
                                                -- Fallback: existence + non-nil position
                                                local okp, p = pcall(function() return u:getPoint() end)
                                                active = okp and p ~= nil
                                            end
                                        end
                                        if active then
                                            local pos = u:getPoint()
                                            local lat, lon, alt = coord.LOtoLL(pos)
                                            local hdg = 0
                                            pcall(function()
                                                local p = Unit.getPosition(u)
                                                if p and p.x then
                                                    -- p.x est le vecteur "avant" de l'unité
                                                    -- heading = atan2(x.z, x.x) en DCS (x=nord, z=est)
                                                    hdg = math.deg(math.atan2(p.x.z, p.x.x))
                                                    if hdg < 0 then hdg = hdg + 360 end
                                                end
                                            end)
                                            local name = Unit.getName(u) or "?"
                                            local typeName = Unit.getTypeName(u) or "?"
                                            local playerName = ""
                                            pcall(function() playerName = Unit.getPlayerName(u) or "" end)
                                            local life = -1
                                            pcall(function()
                                                local l = u:getLife()
                                                local l0 = u:getLife0()
                                                if l0 and l0 > 0 and l then life = math.floor(l/l0*100+0.5) end
                                            end)
                                            
                                            local spd = 0
                                            pcall(function()
                                                local vel = u:getVelocity()
                                                if vel then spd = math.floor(math.sqrt(vel.x*vel.x + vel.z*vel.z)*3.6+0.5) end
                                            end)
                                            
                                            name = name:gsub('\\','\\\\'):gsub('"','\\"')
                                            typeName = typeName:gsub('\\','\\\\'):gsub('"','\\"')
                                            playerName = playerName:gsub('\\','\\\\'):gsub('"','\\"')
                                            local grpName = (grp:getName() or "?"):gsub('\\','\\\\'):gsub('"','\\"')
                                            
                                            results[#results+1] = string.format(
                                                '{"n":"%s","t":"%s","c":"%s","lat":%.8f,"lon":%.8f,"alt":%.1f,"hdg":%.1f,"life":%d,"spd":%d,"cat":"ground","pn":"%s","dx":%.2f,"dz":%.2f,"gn":"%s"}',
                                                name, typeName, coaName, lat, lon, alt, hdg, life, spd, playerName, pos.x, pos.z, grpName
                                            )
                                        end
                                    end
                                end
                            end
                        end
                    end
                    
                    -- Unités air
                    local airGroups = coalition.getGroups(coaSide, Group.Category.AIRPLANE)
                    if airGroups then
                        for _, grp in ipairs(airGroups) do
                            if grp and Group.isExist(grp) then
                                local units = Group.getUnits(grp)
                                if units then
                                    for _, u in ipairs(units) do
                                        local active = false
                                        if u and Unit.isExist(u) then
                                            local hasIsActive, isAct = pcall(function() return u:isActive() end)
                                            if hasIsActive and isAct ~= nil then
                                                active = isAct
                                            else
                                                local okp, p = pcall(function() return u:getPoint() end)
                                                active = okp and p ~= nil
                                            end
                                        end
                                        if active then
                                            local pos = u:getPoint()
                                            local lat, lon, alt = coord.LOtoLL(pos)
                                            local hdg = 0
                                            pcall(function() local p = Unit.getPosition(u) if p and p.x then hdg = math.deg(math.atan2(p.x.z, p.x.x)) if hdg < 0 then hdg = hdg + 360 end end end)
                                            local name = Unit.getName(u) or "?"
                                            local typeName = Unit.getTypeName(u) or "?"
                                            local playerName = ""
                                            pcall(function() playerName = Unit.getPlayerName(u) or "" end)
                                            name = name:gsub('\\','\\\\'):gsub('"','\\"')
                                            typeName = typeName:gsub('\\','\\\\'):gsub('"','\\"')
                                            playerName = playerName:gsub('\\','\\\\'):gsub('"','\\"')
                                            results[#results+1] = string.format(
                                                '{"n":"%s","t":"%s","c":"%s","lat":%.8f,"lon":%.8f,"alt":%.1f,"hdg":%.1f,"life":-1,"cat":"air","pn":"%s","dx":%.2f,"dz":%.2f}',
                                                name, typeName, coaName, lat, lon, alt, hdg, playerName, pos.x, pos.z
                                            )
                                        end
                                    end
                                end
                            end
                        end
                    end
                    
                    -- Hélicoptères
                    local heliGroups = coalition.getGroups(coaSide, Group.Category.HELICOPTER)
                    if heliGroups then
                        for _, grp in ipairs(heliGroups) do
                            if grp and Group.isExist(grp) then
                                local units = Group.getUnits(grp)
                                if units then
                                    for _, u in ipairs(units) do
                                        local active = false
                                        if u and Unit.isExist(u) then
                                            local hasIsActive, isAct = pcall(function() return u:isActive() end)
                                            if hasIsActive and isAct ~= nil then
                                                active = isAct
                                            else
                                                local okp, p = pcall(function() return u:getPoint() end)
                                                active = okp and p ~= nil
                                            end
                                        end
                                        if active then
                                            local pos = u:getPoint()
                                            local lat, lon, alt = coord.LOtoLL(pos)
                                            local hdg = 0
                                            pcall(function() local p = Unit.getPosition(u) if p and p.x then hdg = math.deg(math.atan2(p.x.z, p.x.x)) if hdg < 0 then hdg = hdg + 360 end end end)
                                            local name = Unit.getName(u) or "?"
                                            local typeName = Unit.getTypeName(u) or "?"
                                            local playerName = ""
                                            pcall(function() playerName = Unit.getPlayerName(u) or "" end)
                                            name = name:gsub('\\','\\\\'):gsub('"','\\"')
                                            typeName = typeName:gsub('\\','\\\\'):gsub('"','\\"')
                                            playerName = playerName:gsub('\\','\\\\'):gsub('"','\\"')
                                            results[#results+1] = string.format(
                                                '{"n":"%s","t":"%s","c":"%s","lat":%.8f,"lon":%.8f,"alt":%.1f,"hdg":%.1f,"life":-1,"cat":"heli","pn":"%s","dx":%.2f,"dz":%.2f}',
                                                name, typeName, coaName, lat, lon, alt, hdg, playerName, pos.x, pos.z
                                            )
                                        end
                                    end
                                end
                            end
                        end
                    end
                end
            end)
            
            if #results > 0 then
                return '[' .. table.concat(results, ',') .. ']'
            end
            return '[]'
        ]]
        
        local ok, raw = pcall(net.dostring_in, SIT.env, code)
        if ok and raw and #raw > 2 then
            -- Envoi UDP (prioritaire) ou fichier (fallback)
            if not SIT.sendUDP("W", raw) then
                local f = io.open(SIT.worldPath, "w")
                if f then f:write(raw); f:close() end
            end
            
            if SIT.logCount < 3 then
                log.write("SIT_World", log.INFO, "Worldstate: " .. #raw .. " bytes, ~" .. select(2, raw:gsub(",", "")) + 1 .. " units" .. (SIT.udpSocket and " (UDP)" or " (file)"))
            end
        end
        SIT.logCount = SIT.logCount + 1
    end)
    
    end -- end of main slow path
    
    -- ================================================================
    -- FAST PATH (5 Hz): per-player own-vehicle telemetry
    -- ================================================================
    if ownDue then
    
    -- ================================================================
    -- 6. OWN VEHICLE (V8) : position + telemetry per player
    -- Replaces Export.lua/bridge.js. Emits a compact per-player payload so the
    -- SIT client can display its own vehicle data (pos, heading, turret, ammo, life,
    -- threats) without needing a local Export.lua or bridge.js.
    -- Prefix 'O' over UDP, routed to the matching authenticated client by the server.
    -- ================================================================
    pcall(function()
        local playerNames = {}
        for pid, pinfo in pairs(SIT.trackedPlayers) do
            if pinfo.name and pinfo.slot and pinfo.slot ~= "" and pinfo.slot ~= "observer" then
                playerNames[pinfo.name] = true
            end
        end
        if not next(playerNames) then return end
        
        local nameList = ""
        for pn in pairs(playerNames) do
            local safeName = pn:gsub("'", "\\'"):gsub('"', '\\"')
            if nameList ~= "" then nameList = nameList .. "," end
            nameList = nameList .. '"' .. safeName .. '"'
        end
        
        local code = [[
            local wanted = {]] .. nameList .. [[}
            local wantedSet = {}
            for _, n in ipairs(wanted) do wantedSet[n] = true end
            local results = {}
            pcall(function()
                -- Build a set of enemy missiles in flight, per coalition. We'll filter per-player.
                -- A missile is a world object: category weapon, wsType level1=4 level2=4.
                local enemyMissiles = {}
                pcall(function()
                    local volume = { id = world.VolumeType.BOX, params = { min = {x=-1e9,y=-1e9,z=-1e9}, max = {x=1e9,y=1e9,z=1e9} } }
                    world.searchObjects(Object.Category.WEAPON, volume, function(w)
                        if w and w:isExist() then
                            local ok1, desc = pcall(function() return w:getDesc() end)
                            if ok1 and desc and desc.category == 1 then -- 1 = Missile in Weapon.Category
                                local pos = nil; pcall(function() pos = w:getPoint() end)
                                local vel = nil; pcall(function() vel = w:getVelocity() end)
                                local coa = 0; pcall(function() coa = w:getCoalition() end)
                                local mid = 0; pcall(function() mid = w:getID() end) -- stable ID across frames
                                if pos and vel then
                                    table.insert(enemyMissiles, {pos=pos, vel=vel, coa=coa, id=mid})
                                end
                            end
                        end
                    end)
                end)
                
                for _, coaSide in ipairs({coalition.side.BLUE, coalition.side.RED}) do
                    local groups = coalition.getGroups(coaSide, Group.Category.GROUND)
                    if groups then
                        for _, grp in ipairs(groups) do
                            if grp and Group.isExist(grp) then
                                local units = Group.getUnits(grp)
                                if units then
                                    for _, u in ipairs(units) do
                                        if u and Unit.isExist(u) then
                                            local pn = Unit.getPlayerName(u)
                                            if pn and wantedSet[pn] then
                                                wantedSet[pn] = nil
                                                local p = u:getPoint()
                                                local lat, lon, alt = coord.LOtoLL(p)
                                                local hdg = 0
                                                pcall(function()
                                                    local pp = Unit.getPosition(u)
                                                    if pp and pp.x then
                                                        hdg = math.deg(math.atan2(pp.x.z, pp.x.x))
                                                        if hdg < 0 then hdg = hdg + 360 end
                                                    end
                                                end)
                                                local spd = 0
                                                pcall(function()
                                                    local vel = u:getVelocity()
                                                    if vel then spd = math.floor(math.sqrt(vel.x*vel.x + vel.z*vel.z)*3.6+0.5) end
                                                end)
                                                -- Turret headings via getDrawArgumentValue (universal DCS draw args)
                                                -- 0 = main turret rotation, 25 = commander periscope rotation
                                                local turretHdg = hdg
                                                pcall(function()
                                                    local a = u:getDrawArgumentValue(0)
                                                    if a then
                                                        local rot = a < 0 and -a * 180 or 360 - a * 180
                                                        turretHdg = (hdg + rot) % 360
                                                    end
                                                end)
                                                local cmdHdg = -1
                                                pcall(function()
                                                    local a = u:getDrawArgumentValue(25)
                                                    if a then
                                                        local rot = a < 0 and -a * 180 or 360 - a * 180
                                                        cmdHdg = (turretHdg + rot) % 360
                                                    end
                                                end)
                                                -- Life %
                                                local lifePct = -1
                                                pcall(function()
                                                    local l = u:getLife()
                                                    local l0 = u:getLife0()
                                                    if l0 and l0 > 0 and l then lifePct = math.floor(l/l0*100+0.5) end
                                                end)
                                                -- Ammo
                                                local ammoStr = "[]"
                                                pcall(function()
                                                    local ammo = Unit.getAmmo(u)
                                                    if ammo and #ammo > 0 then
                                                        local parts = {}
                                                        for _, a in ipairs(ammo) do
                                                            local nam = a.desc and (a.desc.displayName or a.desc.typeName) or "Unknown"
                                                            nam = nam:gsub('\\','\\\\'):gsub('"','\\"')
                                                            parts[#parts+1] = string.format('{"name":"%s","count":%d}', nam, a.count or 0)
                                                        end
                                                        if #parts > 0 then ammoStr = '[' .. table.concat(parts,',') .. ']' end
                                                    end
                                                end)
                                                -- Threats: enemy missiles within 2km heading towards us (dot < 0 on approach, angle <= 3deg)
                                                local threatsStr = "[]"
                                                pcall(function()
                                                    local myCoa = u:getCoalition()
                                                    local tparts = {}
                                                    for _, m in ipairs(enemyMissiles) do
                                                        if m.coa ~= myCoa then
                                                            local dx = p.x - m.pos.x
                                                            local dz = p.z - m.pos.z
                                                            local dist = math.sqrt(dx*dx + dz*dz)
                                                            if dist <= 2000 and dist > 5 then
                                                                -- Missile heading = velocity direction (atan2(v.z, v.x))
                                                                local vLen = math.sqrt(m.vel.x*m.vel.x + m.vel.z*m.vel.z)
                                                                if vLen > 10 then -- missile actually moving
                                                                    local mHdg = math.deg(math.atan2(m.vel.z, m.vel.x))
                                                                    if mHdg < 0 then mHdg = mHdg + 360 end
                                                                    -- Heading from missile toward us
                                                                    local toMe = math.deg(math.atan2(dz, dx))
                                                                    if toMe < 0 then toMe = toMe + 360 end
                                                                    local ad = math.abs(mHdg - toMe)
                                                                    if ad > 180 then ad = 360 - ad end
                                                                    if ad <= 5 then -- heading towards us
                                                                        local mlat, mlon = coord.LOtoLL(m.pos)
                                                                        tparts[#tparts+1] = string.format('{"id":%d,"lat":%.6f,"lon":%.6f,"hdg":%.0f,"dist":%.0f,"type":"Missile"}', m.id or 0, mlat, mlon, mHdg, dist)
                                                                    end
                                                                end
                                                            end
                                                        end
                                                    end
                                                    if #tparts > 0 then threatsStr = '[' .. table.concat(tparts, ',') .. ']' end
                                                end)
                                                -- MGRS
                                                local mgrsStr = ""
                                                pcall(function()
                                                    local m = coord.LLtoMGRS(lat, lon)
                                                    if m and m.MGRSDigraph then
                                                        mgrsStr = string.format("%s %s %05d %05d", m.UTMZone or "", m.MGRSDigraph or "", m.Easting or 0, m.Northing or 0)
                                                    end
                                                end)
                                                local safePn = pn:gsub('\\','\\\\'):gsub('"','\\"')
                                                results[#results+1] = string.format(
                                                    '{"pn":"%s","dx":%.1f,"dz":%.1f,"lat":%.6f,"lon":%.6f,"alt":%.0f,"hdg":%.0f,"th":%.0f,"ch":%.0f,"spd":%d,"life":%d,"mgrs":"%s","ammo":%s,"threats":%s}',
                                                    safePn, p.x, p.z, lat, lon, alt, hdg, turretHdg, cmdHdg, spd, lifePct, mgrsStr, ammoStr, threatsStr
                                                )
                                            end
                                        end
                                    end
                                end
                            end
                        end
                    end
                end
            end)
            return '[' .. table.concat(results, ',') .. ']'
        ]]
        local ok, raw = pcall(net.dostring_in, SIT.env, code)
        if ok and raw and #raw > 2 then
            SIT.sendUDP("O", raw)
            -- Light log: count threats across all players for visibility
            if raw:find('"threats":%[{') then
                -- only log when at least one threat is present
                local nThreats = select(2, raw:gsub('"type":"Missile"', ''))
                log.write("SIT_World", log.INFO, "OwnVehicle: " .. nThreats .. " threat(s) detected (bytes=" .. #raw .. ")")
            end
            if SIT.ownLogCount == nil then SIT.ownLogCount = 0 end
            if SIT.ownLogCount < 3 then
                log.write("SIT_World", log.INFO, "OwnVehicle UDP sent: " .. #raw .. " bytes")
                SIT.ownLogCount = SIT.ownLogCount + 1
            end
        end
    end)
    
    end -- end of ownDue fast path
    
    -- ================================================================
    -- MAIN SLOW PATH continues: EVASAN / spawn105 / ravito / mods
    -- ================================================================
    if mainDue then
    
    -- ================================================================
    -- EVASAN: Bootstrap event handler in mission env (once)
    -- ================================================================
    if not SIT.evasanBootstrapped then
        -- Try mission env first; fallback to server
        local evasanEnv = 'mission'
        local testOk, testRes = pcall(net.dostring_in, 'mission', 'return type(world) == "table" and "ok" or "no"')
        if not testOk or testRes ~= "ok" then
            evasanEnv = 'server'
        end
        SIT.evasanEnv = evasanEnv
        local bootstrap = [[
            if not _G.SIT_EVASAN then
                _G.SIT_EVASAN = { events = {}, nextId = 1, recentByPlayer = {}, ejectedPilots = {} }
                local h = {}
                function h:onEvent(e)
                    if not e then return end
                    local et = e.id
                    local now = timer.getTime()
                    -- PILOT_DEAD=6, DEAD=8, CRASH=5, EJECTION=7
                    if et ~= 5 and et ~= 6 and et ~= 7 and et ~= 8 then return end
                    local u = e.initiator
                    if not u then return end
                    local ok, name = pcall(function() return u:getName() end)
                    if not ok or not name then return end
                    local pname = nil
                    pcall(function()
                        if u.getPlayerName then pname = u:getPlayerName() end
                    end)
                    if not pname or pname == '' then return end
                    
                    -- 60s dedup window per player: if we already recorded an event for this player recently, skip
                    -- EXCEPTION: ejection always overrides crash/dead (ejection is the most accurate)
                    local recent = _G.SIT_EVASAN.recentByPlayer[pname]
                    if recent and (now - recent.time) < 60 then
                        -- Only replace if new event is ejection and previous was not
                        if et == 7 and recent.type ~= 'ejection' then
                            -- Remove the old crash/dead entry, record the ejection
                            if recent.key and _G.SIT_EVASAN.events[recent.key] then
                                _G.SIT_EVASAN.events[recent.key] = nil
                            end
                        else
                            return -- Skip: within 60s window for this player
                        end
                    end
                    
                    local pos = nil
                    pcall(function() pos = u:getPoint() end)
                    if not pos then return end
                    local lat, lon = coord.LOtoLL(pos)
                    local coa = 0
                    pcall(function() coa = u:getCoalition() end)
                    local etype = "crash"
                    if et == 6 then etype = "pilot_dead"
                    elseif et == 7 then etype = "ejection"
                    elseif et == 8 then etype = "dead" end
                    local evKey = name .. "_" .. tostring(et) .. "_" .. string.format("%.0f", now)
                    _G.SIT_EVASAN.events[evKey] = {
                        id = _G.SIT_EVASAN.nextId,
                        unitName = name,
                        playerName = pname,
                        type = etype,
                        lat = lat, lon = lon,
                        coalition = coa,
                        time = now
                    }
                    _G.SIT_EVASAN.recentByPlayer[pname] = { time = now, type = etype, key = evKey }
                    _G.SIT_EVASAN.nextId = _G.SIT_EVASAN.nextId + 1
                    
                    -- On EJECTION: store info to track the pilot's parachute unit
                    if et == 7 then
                        _G.SIT_EVASAN.ejectedPilots[pname] = { evKey = evKey, aircraftName = name, time = now, lat = lat, lon = lon }
                    end
                end
                world.addEventHandler(h)
            end
        ]]
        pcall(net.dostring_in, SIT.evasanEnv, bootstrap)
        SIT.evasanBootstrapped = true
        log.write("SIT_World", log.INFO, "EVASAN event handler bootstrapped in env: " .. SIT.evasanEnv)
    end
    
    -- ================================================================
    -- EVASAN: Poll events and write to file for server to pick up
    -- ================================================================
    pcall(function()
        local dumpCode = [[
            if not _G.SIT_EVASAN then return "{}" end
            local parts = {}
            for key, ev in pairs(_G.SIT_EVASAN.events) do
                if not ev._sent then
                    ev._sent = true
                    table.insert(parts, string.format(
                        '{"id":%d,"unitName":"%s","playerName":"%s","type":"%s","lat":%f,"lon":%f,"coalition":%d,"time":%f}',
                        ev.id, (ev.unitName or ''):gsub('"','\\"'), (ev.playerName or ''):gsub('"','\\"'),
                        ev.type, ev.lat, ev.lon, ev.coalition, ev.time
                    ))
                end
            end
            return "[" .. table.concat(parts, ",") .. "]"
        ]]
        local ok, result = pcall(net.dostring_in, SIT.env, dumpCode)
        if ok and result and result ~= "[]" and #result > 2 then
            -- Append to events file
            local existing = ""
            pcall(function()
                local f = io.open(SIT.evasanEventsPath, "r")
                if f then existing = f:read("*a"); f:close() end
            end)
            local f = io.open(SIT.evasanEventsPath, "w")
            if f then
                -- Append new events as JSONL
                if existing ~= "" then f:write(existing) end
                for evStr in result:gmatch('({[^}]*})') do
                    f:write(evStr .. "\n")
                end
                f:close()
            end
        end
    end)
    
    -- ================================================================
    -- EVASAN: Process orders from SIT (spawn, move MERCURE/CHROME, etc.)
    -- ================================================================
    pcall(function()
        local of = io.open(SIT.evasanOrderPath, "r")
        if not of then return end
        local content = of:read("*a")
        of:close()
        if not content or #content < 5 then return end
        os.remove(SIT.evasanOrderPath)
        log.write("SIT_World", log.INFO, "EVASAN order file read: " .. #content .. " bytes")
        
        for line in content:gmatch('[^\r\n]+') do
            if #line >= 10 then
            local action = line:match('"action":"([^"]*)"') or ""
            local lat = tonumber(line:match('"lat":([%-]?[%d%.]+)'))
            local lon = tonumber(line:match('"lon":([%-]?[%d%.]+)'))
            local playerName = line:match('"playerName":"([^"]*)"') or "?"
            local onRoad = line:match('"onRoad":%s*true') ~= nil
            local coa = tonumber(line:match('"coalition":(%d+)')) or 2
            local eventType = line:match('"eventType":"([^"]*)"') or "crash"
            log.write("SIT_World", log.INFO, "EVASAN order line: action=" .. action .. " player=" .. playerName .. " lat=" .. tostring(lat) .. " lon=" .. tostring(lon) .. " coa=" .. coa .. " onRoad=" .. tostring(onRoad) .. " eventType=" .. eventType)
            
            if action == "spawn_soldier" and lat and lon then
                -- On ejection: try to locate the pilot's parachute unit and use IT as rescue target
                -- On crash/dead: spawn Soldier M249 100m from crash (avoid wreck/flames)
                local rnd = math.random(1,999999)
                local safePname = playerName:gsub("[^%w]","")
                local spawnCode
                
                if eventType == "ejection" then
                    -- Try to find parachuted pilot unit
                    spawnCode = string.format([==[
                        local res = "fallback"
                        pcall(function()
                            local pname = "%s"
                            local dest = coord.LLtoLO(%f, %f, 0)
                            -- Scan all groups for a unit whose player name matches (parachute gets transferred to "pilot")
                            -- Also try: any unit within 500m of crash site that wasn't there before is likely the chute
                            local pilotUnit = nil
                            for _, coa in pairs({coalition.side.BLUE, coalition.side.RED}) do
                                for _, g in ipairs(coalition.getGroups(coa, Group.Category.GROUND)) do
                                    if g and g:isExist() then
                                        for _, u in ipairs(g:getUnits() or {}) do
                                            if u and u:isExist() then
                                                local un = u:getName() or ""
                                                -- DCS names ejected pilots with patterns like "<aircraft>#pilot" or similar
                                                if un:match("[Pp]ilot") or un:match("#") then
                                                    local up = u:getPoint()
                                                    local dx = up.x - dest.x
                                                    local dz = up.z - dest.z
                                                    local d = math.sqrt(dx*dx + dz*dz)
                                                    if d < 3000 then -- within 3km of crash
                                                        pilotUnit = u
                                                        break
                                                    end
                                                end
                                            end
                                        end
                                    end
                                    if pilotUnit then break end
                                end
                                if pilotUnit then break end
                            end
                            
                            _G.SIT_EVASAN = _G.SIT_EVASAN or {}
                            _G.SIT_EVASAN.soldiers = _G.SIT_EVASAN.soldiers or {}
                            
                            if pilotUnit then
                                -- Use the actual pilot parachute unit as rescue target
                                local pilotGroup = pilotUnit:getGroup()
                                local gname = pilotGroup:getName()
                                _G.SIT_EVASAN.soldiers[pname] = gname
                                res = "parachute:" .. gname
                            else
                                -- Fallback: spawn soldier M249 at crash site (offset 100m random direction for ejection too)
                                local angle = math.random() * 2 * math.pi
                                local offX = math.cos(angle) * 100
                                local offZ = math.sin(angle) * 100
                                local sx = dest.x + offX
                                local sz = dest.z + offZ
                                local gname = 'EVASAN_%d_%s'
                                local uname = gname .. '_u1'
                                local group = {
                                    visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                                    name = gname,
                                    task = 'Ground Nothing',
                                    x = sx, y = sz,
                                    start_time = 0,
                                    units = {[1] = {
                                        name = uname,
                                        type = 'Soldier M249',
                                        transportable = { randomTransportable = false },
                                        x = sx, y = sz,
                                        heading = 0,
                                        skill = 'High',
                                        playerCanDrive = false,
                                    }}
                                }
                                local country = %d == 2 and country.id.USA or country.id.RUSSIA
                                coalition.addGroup(country, Group.Category.GROUND, group)
                                _G.SIT_EVASAN.soldiers[pname] = gname
                                res = "spawned:" .. gname
                            end
                        end)
                        return res
                    ]==], playerName:gsub("'","\\'"), lat, lon, rnd, safePname, coa)
                else
                    -- Crash/dead: spawn soldier 100m from crash (avoid wreck/flames)
                    spawnCode = string.format([==[
                        local res = "fallback"
                        pcall(function()
                            local pname = "%s"
                            local dest = coord.LLtoLO(%f, %f, 0)
                            local angle = math.random() * 2 * math.pi
                            local offX = math.cos(angle) * 100
                            local offZ = math.sin(angle) * 100
                            local sx = dest.x + offX
                            local sz = dest.z + offZ
                            local gname = 'EVASAN_%d_%s'
                            local uname = gname .. '_u1'
                            local group = {
                                visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                                name = gname,
                                task = 'Ground Nothing',
                                x = sx, y = sz,
                                start_time = 0,
                                units = {[1] = {
                                    name = uname,
                                    type = 'Soldier M249',
                                    transportable = { randomTransportable = false },
                                    x = sx, y = sz,
                                    heading = 0,
                                    skill = 'High',
                                    playerCanDrive = false,
                                }}
                            }
                            local country = %d == 2 and country.id.USA or country.id.RUSSIA
                            coalition.addGroup(country, Group.Category.GROUND, group)
                            _G.SIT_EVASAN = _G.SIT_EVASAN or {}
                            _G.SIT_EVASAN.soldiers = _G.SIT_EVASAN.soldiers or {}
                            _G.SIT_EVASAN.soldiers[pname] = gname
                            res = "spawned_offset:" .. gname
                        end)
                        return res
                    ]==], playerName:gsub("'","\\'"), lat, lon, rnd, safePname, coa)
                end
                
                local okSp, errSp = pcall(net.dostring_in, SIT.env, spawnCode)
                log.write("SIT_World", log.INFO, "EVASAN spawn_soldier[" .. eventType .. "] for " .. playerName .. " at " .. lat .. "," .. lon .. " coa=" .. coa .. " ok=" .. tostring(okSp) .. " res=" .. tostring(errSp))
            elseif (action == "evasan_light" or action == "evasan_heavy") and lat and lon then
                local grpPattern = action == "evasan_light" and "[Mm][Ee][Rr][Cc][Uu][Rr][Ee]" or "[Cc][Hh][Rr][Oo][Mm][Ee]"
                local actionStr = onRoad and "On Road" or "Off Road"
                local moveCode = [==[
                    local result = "not_found"
                    pcall(function()
                        local pattern = "__PATTERN__"
                        local dest = coord.LLtoLO(__LAT__, __LON__, 0)
                        local closest = nil
                        local closestDist = math.huge
                        for _, coa in pairs({coalition.side.BLUE, coalition.side.RED}) do
                            local groups = coalition.getGroups(coa, Group.Category.GROUND)
                            for _, g in ipairs(groups) do
                                if g and g:isExist() then
                                    local gn = g:getName() or ""
                                    if gn:match(pattern) then
                                        local u1 = g:getUnit(1)
                                        if u1 and u1:isExist() then
                                            local p = u1:getPoint()
                                            local dx = p.x - dest.x
                                            local dz = p.z - dest.z
                                            local d = math.sqrt(dx*dx + dz*dz)
                                            if d < closestDist then
                                                closestDist = d
                                                closest = g
                                            end
                                        end
                                    end
                                end
                            end
                        end
                        if not closest then return end
                        local ctrl = closest:getController()
                        if not ctrl then return end
                        local u1 = closest:getUnit(1)
                        if not u1 then return end
                        local curPos = u1:getPoint()
                        local alt1 = land.getHeight({x=curPos.x, y=0, z=curPos.z}) + 0.5
                        local alt2 = land.getHeight({x=dest.x, y=0, z=dest.z}) + 0.5
                        -- Record origin so we can send the group back home after rescue
                        _G.SIT_EVASAN = _G.SIT_EVASAN or {}
                        _G.SIT_EVASAN.rescueOrigin = _G.SIT_EVASAN.rescueOrigin or {}
                        _G.SIT_EVASAN.rescueOrigin[closest:getName()] = {
                            x = curPos.x, z = curPos.z, alt = alt1,
                            action = "__ACTION__", playerName = "__PLAYER__"
                        }
                        local task = {
                            id = 'Mission',
                            params = {
                                route = {
                                    points = {
                                        {
                                            x = curPos.x, y = curPos.z, alt = alt1,
                                            speed = 41.67, speed_locked = true,
                                            type = "Turning Point", action = "__ACTION__",
                                            task = { id = 'ComboTask', params = { tasks = {} } }
                                        },
                                        {
                                            x = dest.x, y = dest.z, alt = alt2,
                                            speed = 41.67, speed_locked = true,
                                            type = "Turning Point", action = "__ACTION__",
                                            task = { id = 'ComboTask', params = { tasks = {} } }
                                        }
                                    }
                                }
                            }
                        }
                        ctrl:setTask(task)
                        pcall(function() ctrl:setOption(AI.Option.Ground.id.ROE, AI.Option.Ground.val.ROE.OPEN_FIRE) end)
                        result = "ok:" .. closest:getName() .. ":" .. math.floor(closestDist)
                    end)
                    return result
                ]==]
                moveCode = moveCode:gsub("__PATTERN__", grpPattern):gsub("__LAT__", tostring(lat)):gsub("__LON__", tostring(lon)):gsub("__ACTION__", actionStr):gsub("__PLAYER__", playerName:gsub("'","\\'"):gsub('"','\\"'))
                local ok, r = pcall(net.dostring_in, SIT.env, moveCode)
                log.write("SIT_World", log.INFO, "EVASAN " .. action .. ": result=" .. tostring(r))
                local resultShort = tostring(r):match("^(%w+)") or "not_found"
                local resFile = io.open(SIT.evasanEventsPath, "a")
                if resFile then
                    resFile:write(string.format('{"type":"evasan_result","action":"%s","playerName":"%s","result":"%s","detail":"%s"}\n',
                        action, playerName, resultShort, tostring(r):gsub('"','\\"')))
                    resFile:close()
                end
            elseif action == "evasan_player" and lat and lon then
                -- Broadcast CSAR message + blue smoke + spawn soldier/parachute
                local rnd = math.random(1,999999)
                local isEjection = (eventType == "ejection")
                local plCode = string.format([==[
                    pcall(function()
                        local pname = "%s"
                        local isEjection = %s
                        local p = coord.LLtoLO(%f, %f, 0)
                        local ground = land.getHeight({x=p.x, y=0, z=p.z}) or 0
                        -- Blue smoke at crash site
                        trigger.action.smoke({x=p.x, y=ground, z=p.z}, trigger.smokeColor.Blue)
                        -- Compute MGRS
                        local mgrsStr = "???"
                        pcall(function()
                            local m = coord.LLtoMGRS(%f, %f)
                            if m and m.MGRSDigraph then
                                mgrsStr = string.format("%%s %%s %%05d %%05d", m.UTMZone or "", m.MGRSDigraph or "", m.Easting or 0, m.Northing or 0)
                            end
                        end)
                        local coaSide = (%d == 2) and coalition.side.BLUE or coalition.side.RED
                        local latDeg, latMin = math.modf(%f)
                        latMin = math.abs(latMin) * 60
                        local lonDeg, lonMin = math.modf(%f)
                        lonMin = math.abs(lonMin) * 60
                        local ddm = string.format("%%d° %%.3f'N / %%d° %%.3f'E", latDeg, latMin, lonDeg, lonMin)
                        local msg = string.format("Nouvelle assignation CSAR pour %%s\nCoords DDM: %%s\nCoords MGRS: %%s\nDemande evacuation immediate", pname, ddm, mgrsStr)
                        trigger.action.outTextForCoalition(coaSide, msg, 90)
                        
                        -- Rescue target: parachute pilot if ejection, else spawn soldier 100m offset
                        local rescueGroup = nil
                        if isEjection then
                            for _, coa in pairs({coalition.side.BLUE, coalition.side.RED}) do
                                for _, g in ipairs(coalition.getGroups(coa, Group.Category.GROUND)) do
                                    if g and g:isExist() then
                                        for _, u in ipairs(g:getUnits() or {}) do
                                            if u and u:isExist() then
                                                local un = u:getName() or ""
                                                if un:match("[Pp]ilot") or un:match("#") then
                                                    local up = u:getPoint()
                                                    local dx = up.x - p.x
                                                    local dz = up.z - p.z
                                                    if math.sqrt(dx*dx + dz*dz) < 3000 then
                                                        rescueGroup = g
                                                        break
                                                    end
                                                end
                                            end
                                        end
                                    end
                                    if rescueGroup then break end
                                end
                                if rescueGroup then break end
                            end
                        end
                        
                        local gname, sPos
                        if rescueGroup then
                            gname = rescueGroup:getName()
                            sPos = rescueGroup:getUnit(1):getPoint()
                        else
                            -- Spawn soldier 100m offset
                            local angle = math.random() * 2 * math.pi
                            local offX = math.cos(angle) * 100
                            local offZ = math.sin(angle) * 100
                            local sx = p.x + offX
                            local sz = p.z + offZ
                            gname = 'EVASAN_PL_%d'
                            local uname = gname .. '_u1'
                            local group = {
                                visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                                name = gname,
                                task = 'Ground Nothing',
                                x = sx, y = sz,
                                start_time = 0,
                                units = {[1] = {
                                    name = uname,
                                    type = 'Soldier M249',
                                    transportable = { randomTransportable = false },
                                    x = sx, y = sz,
                                    heading = 0,
                                    skill = 'High',
                                    playerCanDrive = false,
                                }}
                            }
                            local country = (%d == 2) and country.id.USA or country.id.RUSSIA
                            coalition.addGroup(country, Group.Category.GROUND, group)
                            sPos = {x=sx, y=ground, z=sz}
                        end
                        
                        _G.SIT_EVASAN = _G.SIT_EVASAN or {}
                        _G.SIT_EVASAN.playerRescue = _G.SIT_EVASAN.playerRescue or {}
                        _G.SIT_EVASAN.playerRescue[gname] = {
                            playerName = pname,
                            soldierPos = {x=sPos.x, y=sPos.y or ground, z=sPos.z},
                            coalition = coaSide,
                            isParachute = (rescueGroup ~= nil)
                        }
                    end)
                ]==], playerName:gsub("'","\\'"), tostring(isEjection), lat, lon, lat, lon, coa, lat, lon, rnd, coa)
                local okP, errP = pcall(net.dostring_in, SIT.env, plCode)
                log.write("SIT_World", log.INFO, "EVASAN player rescue " .. playerName .. " coa=" .. coa .. " ejection=" .. tostring(isEjection) .. " ok=" .. tostring(okP) .. " err=" .. tostring(errP))
            end
            end
        end
    end)
    
    -- ================================================================
    -- EVASAN: Monitor player rescue (helicopter near soldier)
    -- ================================================================
    pcall(function()
        local monCode = [==[
            if not _G.SIT_EVASAN or not _G.SIT_EVASAN.playerRescue then return "" end
            local results = {}
            for gname, info in pairs(_G.SIT_EVASAN.playerRescue) do
                if info.stage ~= "done" then
                    -- Find any helicopter within 50m moving < 5 m/s
                    local helis = coalition.getGroups(info.coalition, Group.Category.HELICOPTER)
                    for _, g in ipairs(helis) do
                        for _, u in ipairs(g:getUnits()) do
                            if u:getPlayerName() then
                                local p = u:getPoint()
                                local dx = p.x - info.soldierPos.x
                                local dz = p.z - info.soldierPos.z
                                local d = math.sqrt(dx*dx + dz*dz)
                                local v = u:getVelocity()
                                local sp = math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z)
                                if d < 50 and sp < 5 then
                                    if not info.nearStart then
                                        info.nearStart = timer.getTime()
                                    elseif timer.getTime() - info.nearStart >= 10 then
                                        info.stage = "done"
                                        -- Remove soldier
                                        local sg = Group.getByName(gname)
                                        if sg then sg:destroy() end
                                        local msg = "EVASAN " .. info.playerName .. " realisee"
                                        trigger.action.outTextForCoalition(info.coalition, msg, 30)
                                        table.insert(results, info.playerName)
                                    end
                                    break
                                else
                                    info.nearStart = nil
                                end
                            end
                        end
                        if info.stage == "done" then break end
                    end
                end
            end
            return table.concat(results, "|")
        ]==]
        local ok, res = pcall(net.dostring_in, SIT.env, monCode)
        if ok and res and res ~= "" then
            local evFile = io.open(SIT.evasanEventsPath, "a")
            if evFile then
                for pn in res:gmatch("[^|]+") do
                    evFile:write(string.format('{"type":"evasan_done","playerName":"%s"}\n', pn:gsub('"','\\"')))
                end
                evFile:close()
            end
            log.write("SIT_World", log.INFO, "EVASAN rescue completed: " .. res)
        end
    end)
    
    -- ================================================================
    -- EVASAN: Monitor ground group arrival (MERCURE/CHROME)
    -- ================================================================
    pcall(function()
        local arrCode = [==[
            if not _G.SIT_EVASAN or not _G.SIT_EVASAN.soldiers then return "" end
            local results = {}
            for playerName, sGname in pairs(_G.SIT_EVASAN.soldiers) do
                if not _G.SIT_EVASAN.rescued or not _G.SIT_EVASAN.rescued[playerName] then
                    local sGroup = Group.getByName(sGname)
                    if sGroup and sGroup:isExist() then
                        local su = sGroup:getUnit(1)
                        if su and su:isExist() then
                            local sp = su:getPoint()
                            -- Look for MERCURE or CHROME groups within 100m AND stopped (<5 km/h ~ 1.4 m/s)
                            for _, coa in pairs({coalition.side.BLUE, coalition.side.RED}) do
                                for _, g in ipairs(coalition.getGroups(coa, Group.Category.GROUND)) do
                                    local gn = g:getName() or ""
                                    if gn:match("[Mm][Ee][Rr][Cc][Uu][Rr][Ee]") or gn:match("[Cc][Hh][Rr][Oo][Mm][Ee]") then
                                        local u1 = g:getUnit(1)
                                        if u1 and u1:isExist() then
                                            local gp = u1:getPoint()
                                            local dx = gp.x - sp.x; local dz = gp.z - sp.z
                                            local dist = math.sqrt(dx*dx + dz*dz)
                                            if dist < 100 then
                                                -- Compute speed from velocity vector
                                                local v = u1:getVelocity()
                                                local sp_ms = math.sqrt((v.x or 0)^2 + (v.y or 0)^2 + (v.z or 0)^2)
                                                if sp_ms < 1.4 then
                                                    -- Arrived AND stopped: rescue!
                                                    sGroup:destroy()
                                                    _G.SIT_EVASAN.rescued = _G.SIT_EVASAN.rescued or {}
                                                    _G.SIT_EVASAN.rescued[playerName] = true
                                                    -- Send the rescue group BACK to its origin at 150 km/h (41.67 m/s)
                                                    pcall(function()
                                                        local ctrl = g:getController()
                                                        if not ctrl then return end
                                                        local origin = _G.SIT_EVASAN.rescueOrigin and _G.SIT_EVASAN.rescueOrigin[gn]
                                                        if origin then
                                                            local alt1 = land.getHeight({x=gp.x, y=0, z=gp.z}) + 0.5
                                                            local returnTask = {
                                                                id = 'Mission',
                                                                params = {
                                                                    route = {
                                                                        points = {
                                                                            {
                                                                                x = gp.x, y = gp.z, alt = alt1,
                                                                                speed = 41.67, speed_locked = true,
                                                                                type = "Turning Point", action = origin.action or "Off Road",
                                                                                task = { id = 'ComboTask', params = { tasks = {} } }
                                                                            },
                                                                            {
                                                                                x = origin.x, y = origin.z, alt = origin.alt,
                                                                                speed = 41.67, speed_locked = true,
                                                                                type = "Turning Point", action = origin.action or "Off Road",
                                                                                task = { id = 'ComboTask', params = { tasks = {} } }
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                            ctrl:setTask(returnTask)
                                                            -- Clear origin once sent
                                                            _G.SIT_EVASAN.rescueOrigin[gn] = nil
                                                        else
                                                            -- No origin recorded: just stop
                                                            ctrl:setTask({id='Mission', params={route={points={{x=gp.x,y=gp.z,alt=land.getHeight({x=gp.x,y=0,z=gp.z})+0.5,speed=0,speed_locked=true,type="Turning Point",action="Off Road",task={id='ComboTask',params={tasks={}}}}}}}})
                                                        end
                                                    end)
                                                    trigger.action.outTextForCoalition(coa, "Pilote " .. playerName .. " recupere. Groupe EVASAN en retour vers base.", 30)
                                                    table.insert(results, playerName)
                                                end
                                            end
                                        end
                                    end
                                end
                            end
                        end
                    end
                end
            end
            return table.concat(results, "|")
        ]==]
        local ok, res = pcall(net.dostring_in, SIT.env, arrCode)
        if ok and res and res ~= "" then
            local evFile = io.open(SIT.evasanEventsPath, "a")
            if evFile then
                for pn in res:gmatch("[^|]+") do
                    evFile:write(string.format('{"type":"evasan_ground_done","playerName":"%s"}\n', pn:gsub('"','\\"')))
                end
                evFile:close()
            end
        end
    end)
    
    -- ================================================================
    -- MODS DETECTION: check Frenchpack (Leclerc_XXI), Kappa, DAMS once
    -- ================================================================
    if not SIT.modsChecked then
        local modCheck = [[
            local result = {}
            -- Test known types by trying to get their description
            local function has(t)
                local ok, d = pcall(function() return Unit.getDescByName(t) end)
                return ok and d ~= nil
            end
            result.modpack = has("Leclerc_XXI") and has("VBL50") and has("TRM2000") and has("TRMMISTRAL")
            result.kap = has("KAPPA_Leopard2A7V") or has("KAPPA_BoxerCRV") or has("KAPPA_2S38")
            result.dam = has("ebrc_jaguar") -- DAMS
            return string.format("{\"modpack\":%s,\"kap\":%s,\"dam\":%s}",
                tostring(result.modpack), tostring(result.kap), tostring(result.dam))
        ]]
        local ok, jsonRes = pcall(net.dostring_in, SIT.env, modCheck)
        if ok and jsonRes then
            local f = io.open(SIT.modsStatusPath, "w")
            if f then f:write(jsonRes); f:close() end
            log.write("SIT_World", log.INFO, "MODS detection: " .. jsonRes)
            SIT.modsChecked = true
        end
    end
    
    -- ================================================================
    -- SPAWN 105 (XL package: 3 Leclerc + Atlas/Cubi/Pamela)
    -- ================================================================
    pcall(function()
        local sf = io.open(SIT.spawn105Path, "r")
        if not sf then return end
        local content = sf:read("*a")
        sf:close()
        if not content or #content < 5 then return end
        os.remove(SIT.spawn105Path)
        
        for line in content:gmatch('[^\r\n]+') do
            if #line >= 10 then
            local lat = tonumber(line:match('"lat":([%-]?[%d%.]+)'))
            local lon = tonumber(line:match('"lon":([%-]?[%d%.]+)'))
            local coa = tonumber(line:match('"coalition":(%d+)')) or 2
            local author = line:match('"author":"([^"]*)"') or "SIT"
            
            if lat and lon then
                -- CRITICAL: use a persistent slot counter to ensure unique group/unit names
                SIT.xlCurrentSlot = SIT.xlCurrentSlot + 1
                local slot = SIT.xlCurrentSlot
                
                -- Country id: 80=France/Blue, 81=Russia... but in 105.lua it's 80=blue, 81=red
                local countryId = (coa == 1) and 81 or 80
                
                local spawnCode = string.format([==[
                    pcall(function()
                        local slot = %d
                        local p = coord.LLtoLO(%f, %f, 0)
                        local baseX = p.x
                        local baseZ = p.z
                        local countryId = %d
                        local tankType = "Leclerc_XXI"
                        
                        local g105_name   = "GP_105_" .. slot
                        local g106_name   = "GP_106_" .. slot
                        local g107_name   = "GP_107_" .. slot
                        local gAtlas_name = "GP_Atlas_" .. slot
                        local gCubi_name  = "GP_Cubi_" .. slot
                        local gPam_name   = "GP_Pamela_" .. slot
                        local gMercure_name = "MERCURE_" .. slot
                        local gChrome_name  = "CHROME_" .. slot
                        
                        local u105_name   = "105_" .. slot
                        local u106_name   = "106_" .. slot
                        local u107_name   = "107_" .. slot
                        local uAtlas_name = "Atlas_" .. slot
                        local uCubi_name  = "Cubi_" .. slot
                        local uPam_name   = "Pamela_" .. slot
                        
                        -- 105 : Leclerc principal
                        local grp105 = {
                            visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                            units = {[1] = {
                                type = tankType,
                                transportable = { randomTransportable = false },
                                livery_id = "131st - DV",
                                skill = "Excellent",
                                y = baseZ, x = baseX, name = u105_name,
                                playerCanDrive = true, heading = 0,
                            }},
                            y = baseZ, x = baseX, name = g105_name,
                            start_time = 0, task = "Ground Nothing",
                        }
                        -- 106 : ailier nord (DCS x is North) — preview shows it above
                        local grp106 = {
                            visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                            units = {[1] = {
                                type = tankType,
                                transportable = { randomTransportable = false },
                                livery_id = "131st - DV",
                                skill = "Excellent",
                                y = baseZ, x = baseX + 60, name = u106_name,
                                playerCanDrive = true, heading = 0,
                            }},
                            y = baseZ, x = baseX + 60, name = g106_name,
                            start_time = 0, task = "Ground Nothing",
                        }
                        -- 107 : ailier sud — preview shows it below
                        local grp107 = {
                            visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                            units = {[1] = {
                                type = tankType,
                                transportable = { randomTransportable = false },
                                livery_id = "131st - DV",
                                skill = "Excellent",
                                y = baseZ, x = baseX - 60, name = u107_name,
                                playerCanDrive = true, heading = 0,
                            }},
                            y = baseZ, x = baseX - 60, name = g107_name,
                            start_time = 0, task = "Ground Nothing",
                        }
                        -- Atlas : VBL 200m est (DCS z=East) — preview shows it to the right
                        local grpAtlas = {
                            visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                            units = {[1] = {
                                type = "VBL50",
                                transportable = { randomTransportable = false },
                                skill = "Excellent",
                                y = baseZ + 200, x = baseX, name = uAtlas_name,
                                playerCanDrive = true, heading = 0,
                            }},
                            y = baseZ + 200, x = baseX, name = gAtlas_name,
                            start_time = 0, task = "Ground Nothing",
                        }
                        -- Cubi : TRM2000 200m ouest — preview shows it to the left
                        local grpCubi = {
                            visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                            units = {[1] = {
                                type = "TRM2000",
                                transportable = { randomTransportable = false },
                                skill = "Excellent",
                                y = baseZ - 200, x = baseX, name = uCubi_name,
                                playerCanDrive = true, heading = 0,
                            }},
                            y = baseZ - 200, x = baseX, name = gCubi_name,
                            start_time = 0, task = "Ground Nothing",
                        }
                        -- Pamela : 20m N de Cubi
                        local grpPam = {
                            visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                            units = {[1] = {
                                type = "TRMMISTRAL",
                                transportable = { randomTransportable = false },
                                skill = "Excellent",
                                y = baseZ - 200, x = baseX + 20, name = uPam_name,
                                playerCanDrive = true, heading = 0,
                            }},
                            y = baseZ - 200, x = baseX + 20, name = gPam_name,
                            start_time = 0, task = "Ground Nothing",
                        }
                        
                        -- MERCURE : EVASAN légère (3 véhicules à 500m devant, espacés 50m)
                        -- 1 VBL50 + 1 VAB_50 + 1 VABH
                        local mercX = baseX + 500
                        local grpMercure = {
                            visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                            units = {
                                [1] = {
                                    type = "VBL50",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = baseZ, x = mercX, name = "Mercure_VBL_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                                [2] = {
                                    type = "VAB_50",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = baseZ - 50, x = mercX, name = "Mercure_VAB_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                                [3] = {
                                    type = "VABH",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = baseZ + 50, x = mercX, name = "Mercure_VABH_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                            },
                            y = baseZ, x = mercX, name = gMercure_name,
                            start_time = 0, task = "Ground Nothing",
                        }
                        
                        -- CHROME : EVASAN lourde (4 véhicules à 500m derrière, espacés 50m)
                        -- 2 SEPAR + 2 VBCI
                        local chromeX = baseX - 500
                        local grpChrome = {
                            visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                            units = {
                                [1] = {
                                    type = "SEPAR",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = baseZ - 75, x = chromeX, name = "Chrome_SEPAR1_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                                [2] = {
                                    type = "SEPAR",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = baseZ - 25, x = chromeX, name = "Chrome_SEPAR2_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                                [3] = {
                                    type = "VBCI",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = baseZ + 25, x = chromeX, name = "Chrome_VBCI1_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                                [4] = {
                                    type = "VBCI",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = baseZ + 75, x = chromeX, name = "Chrome_VBCI2_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                            },
                            y = baseZ, x = chromeX, name = gChrome_name,
                            start_time = 0, task = "Ground Nothing",
                        }
                        
                        coalition.addGroup(countryId, Group.Category.GROUND, grp105)
                        coalition.addGroup(countryId, Group.Category.GROUND, grp106)
                        coalition.addGroup(countryId, Group.Category.GROUND, grp107)
                        coalition.addGroup(countryId, Group.Category.GROUND, grpAtlas)
                        coalition.addGroup(countryId, Group.Category.GROUND, grpCubi)
                        coalition.addGroup(countryId, Group.Category.GROUND, grpPam)
                        -- V8: MERCURE + CHROME are now spawned via the separate CSAR button
                        
                        local coalSide = (countryId == 81) and coalition.side.RED or coalition.side.BLUE
                        trigger.action.outTextForCoalition(coalSide,
                            string.format("Peloton 105 (slot %%d) deploye par %%s", slot, "%s"), 15)
                    end)
                ]==], slot, lat, lon, countryId, author:gsub("'","\\'"):gsub('"','\\"'))
                
                local ok, err = pcall(net.dostring_in, SIT.env, spawnCode)
                log.write("SIT_World", log.INFO, "SPAWN 105 slot=" .. slot .. " by " .. author .. " at " .. lat .. "," .. lon .. " ok=" .. tostring(ok))
            end
            end
        end
    end)
    
    -- ================================================================
    -- SPAWN CSAR (MERCURE + CHROME only)
    -- ================================================================
    pcall(function()
        local sf = io.open(SIT.spawnCSARPath, "r")
        if not sf then return end
        local content = sf:read("*a")
        sf:close()
        if not content or #content < 5 then return end
        os.remove(SIT.spawnCSARPath)
        
        for line in content:gmatch('[^\r\n]+') do
            if #line >= 10 then
            local lat = tonumber(line:match('"lat":([%-]?[%d%.]+)'))
            local lon = tonumber(line:match('"lon":([%-]?[%d%.]+)'))
            local coa = tonumber(line:match('"coalition":(%d+)')) or 2
            local author = line:match('"author":"([^"]*)"') or "SIT"
            
            if lat and lon then
                SIT.xlCurrentSlot = SIT.xlCurrentSlot + 1
                local slot = SIT.xlCurrentSlot
                local countryId = (coa == 1) and 81 or 80
                
                local spawnCode = string.format([==[
                    pcall(function()
                        local slot = %d
                        local p = coord.LLtoLO(%f, %f, 0)
                        local baseX = p.x
                        local baseZ = p.z
                        local countryId = %d
                        
                        local gMercure_name = "MERCURE_" .. slot
                        local gChrome_name  = "CHROME_" .. slot
                        
                        -- MERCURE: 3 vehicles 500m east of base, spaced 50m N-S (DCS x=N, z=E)
                        local mercZ = baseZ + 500
                        local grpMercure = {
                            visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                            units = {
                                [1] = {
                                    type = "VBL50",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = mercZ, x = baseX, name = "Mercure_VBL_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                                [2] = {
                                    type = "VAB_50",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = mercZ, x = baseX - 50, name = "Mercure_VAB_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                                [3] = {
                                    type = "VABH",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = mercZ, x = baseX + 50, name = "Mercure_VABH_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                            },
                            y = mercZ, x = baseX, name = gMercure_name,
                            start_time = 0, task = "Ground Nothing",
                        }
                        
                        -- CHROME: 4 vehicles 500m west of base, spaced 50m N-S
                        local chromeZ = baseZ - 500
                        local grpChrome = {
                            visible = false, taskSelected = true, route = {}, tasks = {}, hidden = false,
                            units = {
                                [1] = {
                                    type = "SEPAR",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = chromeZ, x = baseX - 75, name = "Chrome_SEPAR1_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                                [2] = {
                                    type = "SEPAR",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = chromeZ, x = baseX - 25, name = "Chrome_SEPAR2_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                                [3] = {
                                    type = "VBCI",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = chromeZ, x = baseX + 25, name = "Chrome_VBCI1_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                                [4] = {
                                    type = "VBCI",
                                    transportable = { randomTransportable = false },
                                    skill = "Excellent",
                                    y = chromeZ, x = baseX + 75, name = "Chrome_VBCI2_" .. slot,
                                    playerCanDrive = true, heading = 0,
                                },
                            },
                            y = chromeZ, x = baseX, name = gChrome_name,
                            start_time = 0, task = "Ground Nothing",
                        }
                        
                        coalition.addGroup(countryId, Group.Category.GROUND, grpMercure)
                        coalition.addGroup(countryId, Group.Category.GROUND, grpChrome)
                        
                        local coalSide = (countryId == 81) and coalition.side.RED or coalition.side.BLUE
                        trigger.action.outTextForCoalition(coalSide,
                            string.format("Groupes CSAR (slot %%d) deployes par %%s", slot, "%s"), 15)
                    end)
                ]==], slot, lat, lon, countryId, author:gsub("'","\\'"):gsub('"','\\"'))
                
                local ok, err = pcall(net.dostring_in, SIT.env, spawnCode)
                log.write("SIT_World", log.INFO, "SPAWN CSAR slot=" .. slot .. " by " .. author .. " at " .. lat .. "," .. lon .. " ok=" .. tostring(ok))
            end
            end
        end
    end)
    
    -- ================================================================
    -- RAVITO 120: process refuel/resupply orders (Cubi + Pamela -> player)
    -- ================================================================
    pcall(function()
        local rf = io.open(SIT.ravitoOrderPath, "r")
        if not rf then return end
        local content = rf:read("*a")
        rf:close()
        if not content or #content < 5 then return end
        os.remove(SIT.ravitoOrderPath)
        
        for line in content:gmatch('[^\r\n]+') do
            if #line >= 10 then
            local playerName = line:match('"playerName":"([^"]*)"') or ""
            local action = line:match('"action":"([^"]*)"') or ""
            if playerName ~= "" then
                local playerNameEsc = playerName:gsub("'","\\'"):gsub('"','\\"')
                
                if action == "cancel" then
                    -- Find slot of player and stop Cubi/Pamela of that slot
                    local cancelCode = [==[
                        pcall(function()
                            local playerGroupName = nil
                            for _, coa in pairs({coalition.side.BLUE, coalition.side.RED}) do
                                for _, g in ipairs(coalition.getGroups(coa, Group.Category.GROUND)) do
                                    if g and g:isExist() then
                                        for _, u in ipairs(g:getUnits() or {}) do
                                            if u and u:isExist() then
                                                local pn = nil
                                                pcall(function() pn = u:getPlayerName() end)
                                                if pn and pn == "__PLAYER__" then
                                                    playerGroupName = g:getName()
                                                    break
                                                end
                                            end
                                        end
                                    end
                                    if playerGroupName then break end
                                end
                                if playerGroupName then break end
                            end
                            if not playerGroupName then return end
                            local slot = playerGroupName:match("GP_10[567]_(%d+)")
                            if not slot then return end
                            local function stopGroup(gname)
                                local g = Group.getByName(gname)
                                if not g or not g:isExist() then return end
                                local u1 = g:getUnit(1)
                                if not u1 or not u1:isExist() then return end
                                local p = u1:getPoint()
                                local alt = land.getHeight({x=p.x, y=0, z=p.z}) + 0.5
                                local task = {
                                    id = 'Mission',
                                    params = {
                                        route = {
                                            points = {
                                                { x=p.x, y=p.z, alt=alt, speed=0, speed_locked=true, type="Turning Point", action="Off Road", task={id='ComboTask', params={tasks={}}} }
                                            }
                                        }
                                    }
                                }
                                pcall(function() g:getController():setTask(task) end)
                            end
                            stopGroup("GP_Cubi_" .. slot)
                            stopGroup("GP_Pamela_" .. slot)
                        end)
                    ]==]
                    cancelCode = cancelCode:gsub("__PLAYER__", playerNameEsc)
                    pcall(net.dostring_in, SIT.env, cancelCode)
                    log.write("SIT_World", log.INFO, "RAVITO cancelled for " .. playerName)
                else
                    -- Normal spawn: send Cubi + Pamela to player
                    local ravitoCode = [==[
                    local result = "not_found"
                    local reason = ""
                    pcall(function()
                        -- 1) Find the player's unit by getPlayerName
                        local playerUnit = nil
                        local playerGroupName = nil
                        for _, coa in pairs({coalition.side.BLUE, coalition.side.RED}) do
                            for _, g in ipairs(coalition.getGroups(coa, Group.Category.GROUND)) do
                                if g and g:isExist() then
                                    for _, u in ipairs(g:getUnits() or {}) do
                                        if u and u:isExist() then
                                            local pn = nil
                                            pcall(function() pn = u:getPlayerName() end)
                                            if pn and pn == "__PLAYER__" then
                                                playerUnit = u
                                                playerGroupName = g:getName()
                                                break
                                            end
                                        end
                                    end
                                end
                                if playerUnit then break end
                            end
                            if playerUnit then break end
                        end
                        if not playerUnit then reason = "player_not_found"; return end
                        
                        -- 2) Extract slot number from group name (GP_105_N, GP_106_N, GP_107_N)
                        local slot = playerGroupName:match("GP_10[567]_(%d+)")
                        if not slot then reason = "not_in_105_platoon"; return end
                        
                        -- 3) Find Cubi and Pamela of same slot
                        local cubiName = "GP_Cubi_" .. slot
                        local pamName = "GP_Pamela_" .. slot
                        local gCubi = Group.getByName(cubiName)
                        local gPam = Group.getByName(pamName)
                        if not gCubi and not gPam then
                            reason = "cubi_pamela_not_found"
                            return
                        end
                        
                        -- 4) Get player's current position
                        local pp = playerUnit:getPoint()
                        
                        -- 5) Task Cubi and Pamela to move to player position at high speed Off Road
                        local function moveGroup(grp, offX, offZ)
                            if not grp or not grp:isExist() then return end
                            local ctrl = grp:getController()
                            if not ctrl then return end
                            local u1 = grp:getUnit(1)
                            if not u1 or not u1:isExist() then return end
                            local curPos = u1:getPoint()
                            local destX = pp.x + (offX or 0)
                            local destZ = pp.z + (offZ or 0)
                            local alt1 = land.getHeight({ x = curPos.x, y = 0, z = curPos.z }) + 0.5
                            local alt2 = land.getHeight({ x = destX, y = 0, z = destZ }) + 0.5
                            local task = {
                                id = 'Mission',
                                params = {
                                    route = {
                                        points = {
                                            { x = curPos.x, y = curPos.z, alt = alt1, speed = 16.67, speed_locked = true, type = "Turning Point", action = "Off Road", task = { id = 'ComboTask', params = { tasks = {} } } },
                                            { x = destX, y = destZ, alt = alt2, speed = 16.67, speed_locked = true, type = "Turning Point", action = "Off Road", task = { id = 'ComboTask', params = { tasks = {} } } }
                                        }
                                    }
                                }
                            }
                            ctrl:setTask(task)
                        end
                        -- Offset Cubi and Pamela slightly so they don't overlap with player
                        moveGroup(gCubi, 15, 15)   -- 15m NE of player
                        moveGroup(gPam, 15, -15)   -- 15m SE of player
                        result = "ok"
                        reason = "slot_" .. slot
                        
                        trigger.action.outTextForUnit(playerUnit:getID(), "Cubi + Pamela en route pour ravitaillement", 15)
                    end)
                    return result .. "|" .. reason
                ]==]
                ravitoCode = ravitoCode:gsub("__PLAYER__", playerNameEsc)
                local ok, res = pcall(net.dostring_in, SIT.env, ravitoCode)
                local resStr = tostring(res or "error|")
                local result, reason = resStr:match("([^|]+)|(.*)")
                result = result or "error"
                reason = reason or ""
                log.write("SIT_World", log.INFO, "RAVITO for " .. playerName .. ": " .. result .. " (" .. reason .. ")")
                
                -- Write result to events file
                local evFile = io.open(SIT.ravitoEventsPath, "a")
                if evFile then
                    evFile:write(string.format('{"type":"ravito_result","playerName":"%s","result":"%s","reason":"%s"}\n',
                        playerNameEsc, result, reason))
                    evFile:close()
                end
                end  -- end else (non-cancel action)
            end
            end
        end
    end)
    
    end -- end of main slow path (second block)
end

-- Envoi UDP avec fragmentation (max 60KB par paquet)
function SIT.sendUDP(prefix, data)
    if not SIT.udpSocket then return false end
    local ok, err = pcall(function()
        local maxChunk = 60000
        local payload = prefix .. "|" .. data
        if #payload <= maxChunk then
            SIT.udpSocket:sendto("S" .. payload, SIT.UDP_HOST, SIT.UDP_PORT)
        else
            local totalParts = math.ceil(#data / maxChunk)
            local msgId = tostring(os.clock()):sub(-6)
            for i = 1, totalParts do
                local start = (i - 1) * maxChunk + 1
                local chunk = data:sub(start, start + maxChunk - 1)
                local header = "F|" .. prefix .. "|" .. msgId .. "|" .. i .. "|" .. totalParts .. "|"
                SIT.udpSocket:sendto(header .. chunk, SIT.UDP_HOST, SIT.UDP_PORT)
            end
        end
    end)
    if ok then SIT.everSent = true end
    return ok
end

function SIT_Callbacks.onMissionLoadEnd_legacy()
    log.write("SIT_World", log.INFO, "Mission loaded - SIT World Hook ready")
end

DCS.setUserCallbacks(SIT_Callbacks)
log.write("SIT_World", log.INFO, "=== SIT World Hook V10 loaded (mission reset broadcast) ===")
