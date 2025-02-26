import { Client, updateLobby } from "colyseus"
import { Command } from "@colyseus/command"
import { MapSchema } from "@colyseus/schema"
import { nanoid } from "nanoid"

import {
  ItemProposalStages,
  ItemRecipe,
  NeutralStage,
  ItemCarouselStages,
  StageDuration,
  AdditionalPicksStages,
  PortalCarouselStages,
  UniqueShop,
  LegendaryShop,
  MAX_PLAYERS_PER_LOBBY,
  ITEM_CAROUSEL_BASE_DURATION,
  PORTAL_CAROUSEL_BASE_DURATION,
  FIGHTING_PHASE_DURATION
} from "../../types/Config"
import { Item, BasicItems } from "../../types/enum/Item"
import { BattleResult } from "../../types/enum/Game"
import Player from "../../models/colyseus-models/player"
import PokemonFactory from "../../models/pokemon-factory"
import ItemFactory from "../../models/item-factory"
import UserMetadata from "../../models/mongo-models/user-metadata"
import GameRoom from "../game-room"
import { Effect } from "../../types/enum/Effect"
import { Title, Emotion } from "../../types"
import {
  GamePhaseState,
  Rarity,
  PokemonActionState
} from "../../types/enum/Game"
import {
  IDragDropMessage,
  IDragDropItemMessage,
  IDragDropCombineMessage,
  IClient,
  IPokemonEntity,
  Transfer
} from "../../types"
import {
  Pkm,
  PkmDuos,
  PkmIndex,
  PkmProposition
} from "../../types/enum/Pokemon"
import { Pokemon } from "../../models/colyseus-models/pokemon"
import { chance, pickRandomIn } from "../../utils/random"
import { logger } from "../../utils/logger"
import { Passive } from "../../types/enum/Passive"
import { getAvatarString } from "../../public/src/utils"
import { max } from "../../utils/number"
import { getWeather } from "../../utils/weather"
import Simulation from "../../core/simulation"
import { selectMatchups } from "../../core/matchmaking"

export class OnShopCommand extends Command<
  GameRoom,
  {
    id: string
    index: number
  }
> {
  execute({ id, index }) {
    if (id !== undefined && index !== undefined && this.state.players.has(id)) {
      const player = this.state.players.get(id)
      if (player && player.shop[index]) {
        const name = player.shop[index]
        const pokemon = PokemonFactory.createPokemonFromName(name, player)
        const cost = PokemonFactory.getBuyPrice(name)
        if (
          player.money >= cost &&
          (this.room.getBenchSize(player.board) < 8 ||
            (this.room.getPossibleEvolution(player.board, pokemon.name) &&
              this.room.getBenchSize(player.board) == 8))
        ) {
          let allowBuy = true
          if (
            [Rarity.UNIQUE, Rarity.LEGENDARY, Rarity.MYTHICAL].includes(
              pokemon.rarity
            )
          ) {
            player.board.forEach((p) => {
              if (p.name === pokemon.name) {
                allowBuy = false
              }
            })
          }
          if (allowBuy) {
            player.money -= cost
            if (
              pokemon.passive === Passive.PROTEAN2 ||
              pokemon.passive === Passive.PROTEAN3
            ) {
              this.room.checkDynamicSynergies(player, pokemon)
            }

            const x = this.room.getFirstAvailablePositionInBench(player.id)
            pokemon.positionX = x !== undefined ? x : -1
            pokemon.positionY = 0
            player.board.set(pokemon.id, pokemon)

            if (
              pokemon.passive === Passive.UNOWN &&
              player.effects.list.includes(Effect.EERIE_SPELL)
            ) {
              this.state.shop.assignShop(player, true, this.state.stageLevel)
            } else {
              player.shop[index] = Pkm.DEFAULT
            }
            this.room.updateEvolution(id)
          }
        }
      }
    }
  }
}

export class OnItemCommand extends Command<
  GameRoom,
  {
    playerId: string
    id: string
  }
> {
  execute({ playerId, id }) {
    const player = this.state.players.get(playerId)
    if (player) {
      if (player.itemsProposition.includes(id)) {
        player.items.add(id)
      }
      while (player.itemsProposition.length > 0) {
        player.itemsProposition.pop()
      }
    }
  }
}

export class OnPokemonPropositionCommand extends Command<
  GameRoom,
  {
    playerId: string
    pkm: PkmProposition
  }
> {
  execute({ playerId, pkm }: { playerId: string; pkm: PkmProposition }) {
    const player = this.state.players.get(playerId)
    if (
      player &&
      player.pokemonsProposition.length > 0 &&
      !this.state.additionalPokemons.includes(pkm) &&
      this.room.getBenchSize(player.board) < 8
    ) {
      if (AdditionalPicksStages.includes(this.state.stageLevel)) {
        this.state.additionalPokemons.push(pkm)
        this.state.shop.addAdditionalPokemon(pkm)
      }

      let allowBuy = true
      if (
        UniqueShop.includes(pkm) &&
        this.state.stageLevel !== PortalCarouselStages[0]
      ) {
        allowBuy = false // wrong stage
      }
      if (
        LegendaryShop.includes(pkm) &&
        this.state.stageLevel !== PortalCarouselStages[1]
      ) {
        allowBuy = false // wrong stage
      }

      player.board.forEach((p) => {
        if (UniqueShop.includes(pkm) && UniqueShop.includes(p.name)) {
          allowBuy = false // already picked a T10 mythical
        }
        if (LegendaryShop.includes(pkm) && LegendaryShop.includes(p.name)) {
          allowBuy = false // already picked a T20 mythical
        }
      })

      const freeCellsOnBench: number[] = []
      for (let i = 0; i < 8; i++) {
        if (this.room.isPositionEmpty(playerId, i, 0)) {
          freeCellsOnBench.push(i)
        }
      }

      const pokemonsObtained: Pokemon[] = (
        pkm in PkmDuos ? PkmDuos[pkm] : [pkm]
      ).map((p) => PokemonFactory.createPokemonFromName(p, player))
      const hasSpaceOnBench = freeCellsOnBench.length >= pokemonsObtained.length

      if (allowBuy && hasSpaceOnBench) {
        pokemonsObtained.forEach((pokemon) => {
          const freeCellX = this.room.getFirstAvailablePositionInBench(
            player.id
          )
          if (freeCellX === undefined) return
          pokemon.positionX = freeCellX
          pokemon.positionY = 0
          player.board.set(pokemon.id, pokemon)
        })

        while (player.pokemonsProposition.length > 0) {
          player.pokemonsProposition.pop()
        }
      }
    }
  }
}

export class OnDragDropCommand extends Command<
  GameRoom,
  {
    client: IClient
    detail: IDragDropMessage
  }
> {
  execute({ client, detail }) {
    const commands = []
    let success = false
    let dittoReplaced = false
    const message = {
      updateBoard: true,
      updateItems: true
    }
    const playerId = client.auth.uid
    const player = this.state.players.get(playerId)

    if (player) {
      message.updateItems = false
      const pokemon = player.board.get(detail.id)
      if (pokemon) {
        if (
          pokemon.passive === Passive.PROTEAN2 ||
          pokemon.passive === Passive.PROTEAN3
        ) {
          this.room.checkDynamicSynergies(player, pokemon)
        }
        const x = parseInt(detail.x)
        const y = parseInt(detail.y)
        if (pokemon.name === Pkm.DITTO) {
          const pokemonToClone = this.room.getPokemonByPosition(playerId, x, y)
          if (pokemonToClone && pokemonToClone.canBeCloned) {
            dittoReplaced = true
            const replaceDitto = PokemonFactory.createPokemonFromName(
              PokemonFactory.getPokemonBaseEvolution(pokemonToClone.name),
              player
            )
            pokemon.items.forEach((it) => {
              player.items.add(it)
            })
            player.board.delete(detail.id)
            const position =
              this.room.getFirstAvailablePositionInBench(playerId)
            if (position !== undefined) {
              replaceDitto.positionX = position
              replaceDitto.positionY = 0
              player.board.set(replaceDitto.id, replaceDitto)
              success = true
              message.updateBoard = false
            }
          } else if (y === 0) {
            this.room.swap(playerId, pokemon, x, y)
            success = true
          }
        } else {
          const dropOnBench = y == 0
          const dropFromBench = pokemon.isOnBench
          // Drag and drop pokemons through bench has no limitation
          if (dropOnBench && dropFromBench) {
            this.room.swap(playerId, pokemon, x, y)
            success = true
          } else if (this.state.phase == GamePhaseState.PICK) {
            // On pick, allow to drop on / from board
            const teamSize = this.room.getTeamSize(player.board)
            const isBoardFull = teamSize >= player.experienceManager.level
            const dropToEmptyPlace = this.room.isPositionEmpty(playerId, x, y)

            if (dropOnBench) {
              // From board to bench is always allowed (bench to bench is already handled)
              this.room.swap(playerId, pokemon, x, y)
              success = true
            } else {
              if (pokemon.canBePlaced) {
                // Prevents a pokemon to go on the board only if it's adding a pokemon from the bench on a full board
                if (!isBoardFull || !dropToEmptyPlace || !dropFromBench) {
                  this.room.swap(playerId, pokemon, x, y)
                  pokemon.onChangePosition(x, y, player)
                  success = true
                }
              }
            }
          }
        }
        player.synergies.update(player.board)
        player.effects.update(player.synergies, player.board)
        player.boardSize = this.room.getTeamSize(player.board)
      }

      if (!success && client.send) {
        client.send(Transfer.DRAG_DROP_FAILED, message)
      }
      if (dittoReplaced) {
        this.room.updateEvolution(playerId)
      }

      player.synergies.update(player.board)
      player.effects.update(player.synergies, player.board)
    }
    if (commands.length > 0) {
      return commands
    }
  }
}

export class OnDragDropCombineCommand extends Command<
  GameRoom,
  {
    client: Client
    detail: IDragDropCombineMessage
  }
> {
  execute({ client, detail }) {
    const playerId = client.auth.uid
    const message = {
      updateBoard: true,
      updateItems: true
    }
    const player = this.state.players.get(playerId)

    if (player) {
      message.updateBoard = false
      message.updateItems = true

      const itemA = detail.itemA
      const itemB = detail.itemB

      //verify player has both items
      if (!player.items.has(itemA) || !player.items.has(itemB)) {
        client.send(Transfer.DRAG_DROP_FAILED, message)
        return
      }
      // check for two if both items are same
      else if (itemA == itemB) {
        let count = 0
        player.items.forEach((item) => {
          if (item == itemA) {
            count++
          }
        })

        if (count < 2) {
          client.send(Transfer.DRAG_DROP_FAILED, message)
          return
        }
      }

      // find recipe result
      let result: Item | undefined = undefined
      for (const [key, value] of Object.entries(ItemRecipe) as [
        Item,
        Item[]
      ][]) {
        if (
          (value[0] == itemA && value[1] == itemB) ||
          (value[0] == itemB && value[1] == itemA)
        ) {
          result = key
          break
        }
      }

      if (!result) {
        client.send(Transfer.DRAG_DROP_FAILED, message)
        return
      } else {
        player.items.add(result)
        player.items.delete(itemA)
        player.items.delete(itemB)
      }

      player.synergies.update(player.board)
      player.effects.update(player.synergies, player.board)
    }
  }
}
export class OnDragDropItemCommand extends Command<
  GameRoom,
  {
    client: Client
    detail: IDragDropItemMessage
  }
> {
  execute({ client, detail }) {
    const commands = new Array<Command>()
    const playerId = client.auth.uid
    const message = {
      updateBoard: true,
      updateItems: true
    }
    const player = this.state.players.get(playerId)
    if (player) {
      message.updateBoard = false
      message.updateItems = true

      const item = detail.id

      if (!player.items.has(item) && !detail.bypass) {
        client.send(Transfer.DRAG_DROP_FAILED, message)
        return
      }

      const x = parseInt(detail.x)
      const y = parseInt(detail.y)

      const pokemon = player.getPokemonAt(x, y)

      if (pokemon === undefined || !pokemon.canHoldItems) {
        client.send(Transfer.DRAG_DROP_FAILED, message)
        return
      }
      // check if full items
      if (pokemon.items.size >= 3) {
        if (BasicItems.includes(item)) {
          let includesBasicItem = false
          pokemon.items.forEach((i) => {
            if (BasicItems.includes(i)) {
              includesBasicItem = true
            }
          })
          if (!includesBasicItem) {
            client.send(Transfer.DRAG_DROP_FAILED, message)
            return
          }
        } else {
          client.send(Transfer.DRAG_DROP_FAILED, message)
          return
        }
      }

      // SPECIAL CASES: create a new pokemon on item equip
      let newPokemon: Pokemon | undefined = undefined
      const equipAfterTransform = true

      switch (pokemon.name) {
        case Pkm.EEVEE:
          switch (item) {
            case Item.WATER_STONE:
              newPokemon = PokemonFactory.transformPokemon(
                pokemon,
                Pkm.VAPOREON,
                player
              )
              break
            case Item.FIRE_STONE:
              newPokemon = PokemonFactory.transformPokemon(
                pokemon,
                Pkm.FLAREON,
                player
              )
              break
            case Item.THUNDER_STONE:
              newPokemon = PokemonFactory.transformPokemon(
                pokemon,
                Pkm.JOLTEON,
                player
              )
              break
            case Item.DUSK_STONE:
              newPokemon = PokemonFactory.transformPokemon(
                pokemon,
                Pkm.UMBREON,
                player
              )
              break
            case Item.MOON_STONE:
              newPokemon = PokemonFactory.transformPokemon(
                pokemon,
                Pkm.SYLVEON,
                player
              )
              break
            case Item.LEAF_STONE:
              newPokemon = PokemonFactory.transformPokemon(
                pokemon,
                Pkm.LEAFEON,
                player
              )
              break
            case Item.DAWN_STONE:
              newPokemon = PokemonFactory.transformPokemon(
                pokemon,
                Pkm.ESPEON,
                player
              )
              break
            case Item.ICE_STONE:
              newPokemon = PokemonFactory.transformPokemon(
                pokemon,
                Pkm.GLACEON,
                player
              )
              break
          }
          break

        case Pkm.PHIONE:
          if (item === Item.AQUA_EGG) {
            newPokemon = PokemonFactory.transformPokemon(
              pokemon,
              Pkm.MANAPHY,
              player
            )
          }
          break

        case Pkm.GROUDON:
          if (item === Item.RED_ORB) {
            newPokemon = PokemonFactory.transformPokemon(
              pokemon,
              Pkm.PRIMAL_GROUDON,
              player
            )
          }
          break
        case Pkm.KYOGRE:
          if (item === Item.BLUE_ORB) {
            newPokemon = PokemonFactory.transformPokemon(
              pokemon,
              Pkm.PRIMAL_KYOGRE,
              player
            )
          }
          break
        case Pkm.RAYQUAZA:
          if (item === Item.DELTA_ORB) {
            newPokemon = PokemonFactory.transformPokemon(
              pokemon,
              Pkm.MEGA_RAYQUAZA,
              player
            )
          }
          break
        case Pkm.SHAYMIN:
          if (item === Item.GRACIDEA_FLOWER) {
            newPokemon = PokemonFactory.transformPokemon(
              pokemon,
              Pkm.SHAYMIN_SKY,
              player
            )
          }
          break
        case Pkm.TYROGUE: {
          let evol = Pkm.HITMONTOP
          if (
            item === Item.CHARCOAL ||
            item === Item.MAGNET ||
            (item in ItemRecipe && ItemRecipe[item].includes(Item.CHARCOAL)) ||
            (item in ItemRecipe && ItemRecipe[item].includes(Item.MAGNET))
          ) {
            evol = Pkm.HITMONLEE
          }
          if (
            item === Item.HEART_SCALE ||
            item === Item.NEVER_MELT_ICE ||
            (item in ItemRecipe &&
              ItemRecipe[item].includes(Item.HEART_SCALE)) ||
            (item in ItemRecipe &&
              ItemRecipe[item].includes(Item.NEVER_MELT_ICE))
          ) {
            evol = Pkm.HITMONCHAN
          }
          newPokemon = PokemonFactory.transformPokemon(pokemon, evol, player)
          break
        }
        case Pkm.GLIGAR:
          if (item === Item.RAZOR_FANG) {
            newPokemon = PokemonFactory.transformPokemon(
              pokemon,
              Pkm.GLISCOR,
              player
            )
          }
          break
      }

      if (newPokemon) {
        // delete the extra pokemons
        player.board.delete(pokemon.id)
        player.board.set(newPokemon.id, newPokemon)
        player.synergies.update(player.board)
        player.effects.update(player.synergies, player.board)
        player.boardSize = this.room.getTeamSize(player.board)
        if (equipAfterTransform) {
          newPokemon.items.add(item)
        }
        player.items.delete(item)
        return
      }

      if (BasicItems.includes(item)) {
        let itemToCombine
        pokemon.items.forEach((i) => {
          if (BasicItems.includes(i)) {
            itemToCombine = i
          }
        })
        if (itemToCombine) {
          Object.keys(ItemRecipe).forEach((n) => {
            const name = n as Item
            const recipe = ItemRecipe[name]
            if (
              recipe &&
              ((recipe[0] == itemToCombine && recipe[1] == item) ||
                (recipe[0] == item && recipe[1] == itemToCombine))
            ) {
              pokemon.items.delete(itemToCombine)
              player.items.delete(item)

              if (pokemon.items.has(name)) {
                player.items.add(name)
              } else {
                const detail: IDragDropItemMessage = {
                  id: name,
                  x: pokemon.positionX,
                  y: pokemon.positionY,
                  bypass: true
                }
                commands.push(
                  new OnDragDropItemCommand().setPayload({
                    client: client,
                    detail: detail
                  })
                )
              }
            }
          })
        } else {
          pokemon.items.add(item)
          player.items.delete(item)
        }
      } else {
        if (pokemon.items.has(item)) {
          client.send(Transfer.DRAG_DROP_FAILED, message)
          return
        } else {
          pokemon.items.add(item)
          player.items.delete(item)
        }
      }

      player.synergies.update(player.board)
      player.effects.update(player.synergies, player.board)
      if (commands.length > 0) {
        return commands
      }
    }
  }
}

export class OnSellDropCommand extends Command<
  GameRoom,
  {
    client: Client
    detail: { pokemonId: string }
  }
> {
  execute({ client, detail }) {
    const player = this.state.players.get(client.auth.uid)

    if (player) {
      const pokemon = player.board.get(detail.pokemonId)
      if (
        pokemon &&
        !pokemon.isOnBench &&
        this.state.phase === GamePhaseState.FIGHT
      ) {
        return // can't sell a pokemon currently fighting
      }

      if (pokemon) {
        this.state.shop.releasePokemon(pokemon.name)
        player.money += PokemonFactory.getSellPrice(pokemon.name)
        pokemon.items.forEach((it) => {
          player.items.add(it)
        })

        player.board.delete(detail.pokemonId)

        player.synergies.update(player.board)
        player.effects.update(player.synergies, player.board)
        player.boardSize = this.room.getTeamSize(player.board)
      }
    }
  }
}

export class OnRefreshCommand extends Command<
  GameRoom,
  {
    id: string
  }
> {
  execute(id) {
    const player = this.state.players.get(id)
    if (player && player.money >= 1 && player.alive) {
      this.state.shop.assignShop(player, true, this.state.stageLevel)
      player.money -= 1
      player.rerollCount++
    }
  }
}

export class OnLockCommand extends Command<
  GameRoom,
  {
    id: string
  }
> {
  execute(id) {
    const player = this.state.players.get(id)
    if (player) {
      player.shopLocked = !player.shopLocked
    }
  }
}

export class OnLevelUpCommand extends Command<
  GameRoom,
  {
    id: string
  }
> {
  execute(id) {
    const player = this.state.players.get(id)
    if (player) {
      if (player.money >= 4 && player.experienceManager.canLevel()) {
        player.experienceManager.addExperience(4)
        player.money -= 4
      }
    }
  }
}

export class OnJoinCommand extends Command<
  GameRoom,
  {
    client: Client
    options: { spectate?: boolean }
    auth
  }
> {
  async execute({ client, options, auth }) {
    try {
      if (options.spectate === true) {
        this.state.spectators.add(client.auth.uid)
      } else {
        const user = await UserMetadata.findOne({ uid: auth.uid })
        if (user) {
          const player = new Player(
            user.uid,
            user.displayName,
            user.elo,
            user.avatar,
            false,
            this.state.players.size + 1,
            user.pokemonCollection,
            user.title,
            user.role
          )

          this.state.players.set(client.auth.uid, player)

          if (client && client.auth && client.auth.displayName) {
            logger.info(
              `${client.auth.displayName} ${client.id} join game room`
            )
          }

          this.state.shop.assignShop(player, false, this.state.stageLevel)
          if (this.state.players.size >= MAX_PLAYERS_PER_LOBBY) {
            let nbHumanPlayers = 0
            this.state.players.forEach((p) => {
              if (!p.isBot) {
                nbHumanPlayers += 1
              }
            })
            if (nbHumanPlayers === 1) {
              this.state.players.forEach((p) => {
                if (!p.isBot) {
                  p.titles.add(Title.LONE_WOLF)
                }
              })
            }
          }
        }
      }
    } catch (error) {
      logger.error(error)
    }
  }
}

export class OnUpdateCommand extends Command<
  GameRoom,
  {
    deltaTime: number
  }
> {
  execute({ deltaTime }) {
    if (deltaTime) {
      let updatePhaseNeeded = false
      this.state.time -= deltaTime
      if (Math.round(this.state.time / 1000) != this.state.roundTime) {
        this.state.roundTime = Math.round(this.state.time / 1000)
      }
      if (this.state.time < 0) {
        updatePhaseNeeded = true
      } else if (this.state.phase == GamePhaseState.FIGHT) {
        let everySimulationFinished = true

        this.state.simulations.forEach((simulation) => {
          if (!simulation.finished) {
            everySimulationFinished = false
          }
          simulation.update(deltaTime)
        })

        if (everySimulationFinished) {
          updatePhaseNeeded = true
        }
      } else if (this.state.phase === GamePhaseState.MINIGAME) {
        this.room.miniGame.update(deltaTime)
      }
      if (updatePhaseNeeded) {
        return [new OnUpdatePhaseCommand()]
      }
    }
  }
}

export class OnUpdatePhaseCommand extends Command<GameRoom> {
  execute() {
    if (this.state.phase == GamePhaseState.MINIGAME) {
      this.room.miniGame.stop(this.state)
      this.initializePickingPhase()
    } else if (this.state.phase == GamePhaseState.PICK) {
      this.stopPickingPhase()
      const commands = this.checkForLazyTeam()
      if (commands.length != 0) {
        return commands
      }
      this.initializeFightingPhase()
    } else if (this.state.phase == GamePhaseState.FIGHT) {
      const kickCommands = this.stopFightingPhase()
      if (kickCommands.length != 0) {
        return kickCommands
      }

      if (
        ItemCarouselStages.includes(this.state.stageLevel) ||
        PortalCarouselStages.includes(this.state.stageLevel)
      ) {
        this.initializeMinigamePhase()
      } else {
        this.initializePickingPhase()
      }
    }
  }

  computeAchievements() {
    this.state.players.forEach((player) => {
      this.checkSuccess(player)
    })
  }

  checkSuccess(player: Player) {
    player.titles.add(Title.NOVICE)
    const effects = this.state.simulations
      .get(player.simulationId)
      ?.getEffects(player.id)
    if (effects) {
      effects.forEach((effect) => {
        switch (effect) {
          case Effect.PURE_POWER:
            player.titles.add(Title.POKEFAN)
            break
          case Effect.SPORE:
            player.titles.add(Title.POKEMON_RANGER)
            break
          case Effect.DESOLATE_LAND:
            player.titles.add(Title.KINDLER)
            break
          case Effect.PRIMORDIAL_SEA:
            player.titles.add(Title.FIREFIGHTER)
            break
          case Effect.OVERDRIVE:
            player.titles.add(Title.ELECTRICIAN)
            break
          case Effect.JUSTIFIED:
            player.titles.add(Title.BLACK_BELT)
            break
          case Effect.EERIE_SPELL:
            player.titles.add(Title.TELEKINESIST)
            break
          case Effect.BEAT_UP:
            player.titles.add(Title.DELINQUENT)
            break
          case Effect.STEEL_SURGE:
            player.titles.add(Title.ENGINEER)
            break
          case Effect.DRILLER:
            player.titles.add(Title.GEOLOGIST)
            break
          case Effect.TOXIC:
            player.titles.add(Title.TEAM_ROCKET_GRUNT)
            break
          case Effect.DRAGON_DANCE:
            player.titles.add(Title.DRAGON_TAMER)
            break
          case Effect.ANGER_POINT:
            player.titles.add(Title.CAMPER)
            break
          case Effect.POWER_TRIP:
            player.titles.add(Title.MYTH_TRAINER)
            break
          case Effect.CALM_MIND:
            player.titles.add(Title.RIVAL)
            break
          case Effect.WATER_VEIL:
            player.titles.add(Title.DIVER)
            break
          case Effect.HEART_OF_THE_SWARM:
            player.titles.add(Title.BUG_MANIAC)
            break
          case Effect.MAX_GUARD:
            player.titles.add(Title.BIRD_KEEPER)
            break
          case Effect.SUN_FLOWER:
            player.titles.add(Title.GARDENER)
            break
          case Effect.GOOGLE_SPECS:
            player.titles.add(Title.ALCHEMIST)
            break
          case Effect.DIAMOND_STORM:
            player.titles.add(Title.HIKER)
            break
          case Effect.CURSE:
            player.titles.add(Title.HEX_MANIAC)
            break
          case Effect.STRANGE_STEAM:
            player.titles.add(Title.CUTE_MANIAC)
            break
          case Effect.SHEER_COLD:
            player.titles.add(Title.SKIER)
            break
          case Effect.FORGOTTEN_POWER:
            player.titles.add(Title.MUSEUM_DIRECTOR)
            break
          case Effect.PRESTO:
            player.titles.add(Title.MUSICIAN)
            break
          case Effect.BREEDER:
            player.titles.add(Title.BABYSITTER)
            break
          default:
            break
        }
      })
      if (effects.length >= 5) {
        player.titles.add(Title.HARLEQUIN)
      }
      let shield = 0
      let heal = 0
      const dpsMeter = this.state.simulations
        .get(player.simulationId)
        ?.getHealDpsMeter(player.id)

      if (dpsMeter) {
        dpsMeter.forEach((v) => {
          shield += v.shield
          heal += v.heal
        })
      }

      if (shield > 1000) {
        player.titles.add(Title.GARDIAN)
      }
      if (heal > 1000) {
        player.titles.add(Title.NURSE)
      }
    }
  }

  checkEndGame() {
    const commands = []
    const numberOfPlayersAlive = this.room.getNumberOfPlayersAlive(
      this.state.players
    )

    if (numberOfPlayersAlive <= 1) {
      this.state.gameFinished = true
      this.room.broadcast(Transfer.BROADCAST_INFO, {
        title: "End of the game",
        info: "We have a winner !"
      })
      setTimeout(() => {
        // dispose the room automatically after 30 seconds
        this.room.broadcast(Transfer.GAME_END)
        this.room.disconnect()
      }, 30 * 1000)
    }
    return commands
  }

  computePlayerDamage(
    opponentTeam: MapSchema<IPokemonEntity>,
    stageLevel: number
  ) {
    let damage = Math.ceil(stageLevel / 2)
    if (opponentTeam.size > 0) {
      opponentTeam.forEach((pokemon) => {
        if (!pokemon.isClone) {
          damage += pokemon.stars
        }
      })
    }
    return damage
  }

  rankPlayers() {
    const rankArray = new Array<{ id: string; life: number; level: number }>()
    this.state.players.forEach((player) => {
      if (!player.alive) {
        return
      }

      rankArray.push({
        id: player.id,
        life: player.life,
        level: player.experienceManager.level
      })
    })

    const sortPlayers = (
      a: { id: string; life: number; level: number },
      b: { id: string; life: number; level: number }
    ) => {
      let diff = b.life - a.life
      if (diff == 0) {
        diff = b.level - a.level
      }
      return diff
    }

    rankArray.sort(sortPlayers)

    rankArray.forEach((rankPlayer, index) => {
      const player = this.state.players.get(rankPlayer.id)
      if (player) {
        player.rank = index + 1
      }
    })
  }

  computeLife() {
    this.state.players.forEach((player) => {
      if (player.alive) {
        const currentResult = this.state.simulations
          .get(player.simulationId)
          ?.getCurrentBattleResult(player.id)

        const opponentTeam = this.state.simulations
          .get(player.simulationId)
          ?.getOpponentTeam(player.id)
        if (
          opponentTeam &&
          (currentResult === BattleResult.DEFEAT ||
            currentResult === BattleResult.DRAW)
        ) {
          const playerDamage = this.computePlayerDamage(
            opponentTeam,
            this.state.stageLevel
          )
          player.life -= playerDamage
          if (playerDamage > 0) {
            const client = this.room.clients.find(
              (cli) => cli.auth.uid === player.id
            )
            client?.send(Transfer.PLAYER_DAMAGE, playerDamage)
          }
        }
      }
    })
  }

  computeStreak(isPVE: boolean) {
    if (isPVE) return // PVE rounds do not change the current streak
    this.state.players.forEach((player) => {
      if (!player.alive) {
        return
      }
      const currentResult = this.state.simulations
        .get(player.simulationId)
        ?.getCurrentBattleResult(player.id)
      const currentStreakType = player.getCurrentStreakType()

      if (currentResult === BattleResult.DRAW) {
        // preserve existing streak but lose HP
      } else if (currentResult !== currentStreakType) {
        // reset streak
        player.streak = 0
      } else {
        player.streak = max(5)(player.streak + 1)
      }
    })
  }

  computeIncome() {
    this.state.players.forEach((player) => {
      let income = 0
      if (player.alive && !player.isBot) {
        player.interest = Math.min(Math.floor(player.money / 10), 5)
        income += player.interest
        income += player.streak
        if (player.getLastBattleResult() == BattleResult.WIN) {
          income += 1
        }
        income += 5
        player.money += income
        if (income > 0) {
          const client = this.room.clients.find(
            (cli) => cli.auth.uid === player.id
          )
          client?.send(Transfer.PLAYER_INCOME, income)
        }
        player.experienceManager.addExperience(2)
      }
    })
  }

  registerBattleResults(isPVE: boolean) {
    this.state.players.forEach((player) => {
      if (player.alive) {
        const currentResult = this.state.simulations
          .get(player.simulationId)
          ?.getCurrentBattleResult(player.id)
        if (currentResult) {
          player.addBattleResult(
            player.opponentName,
            currentResult,
            player.opponentAvatar,
            isPVE,
            this.state.simulations.get(player.simulationId)?.weather
          )
        }
      }
    })
  }

  checkDeath() {
    this.state.players.forEach((player: Player) => {
      if (player.life <= 0 && player.alive) {
        if (!player.isBot) {
          player.shop.forEach((pkm) => {
            this.state.shop.releasePokemon(pkm)
          })
          player.board.forEach((pokemon) => {
            this.state.shop.releasePokemon(pokemon.name)
          })
        }
        player.life = 0
        player.alive = false
      }
    })
  }

  initializePickingPhase() {
    this.state.phase = GamePhaseState.PICK
    this.state.time =
      (StageDuration[this.state.stageLevel] ?? StageDuration.DEFAULT) * 1000

    // Item propositions stages
    if (ItemProposalStages.includes(this.state.stageLevel)) {
      this.state.players.forEach((player: Player) => {
        const items = ItemFactory.createRandomItems()
        items.forEach((item) => {
          player.itemsProposition.push(item)
        })
      })
    }

    // First additional pick stage
    if (this.state.stageLevel === AdditionalPicksStages[0]) {
      this.state.players.forEach((player: Player) => {
        if (player.isBot) {
          const p = this.room.additionalPokemonsPool1.pop()
          if (p) {
            this.state.additionalPokemons.push(p)
            this.state.shop.addAdditionalPokemon(p)
          }
        } else {
          for (let i = 0; i < 3; i++) {
            const p = this.room.additionalPokemonsPool1.pop()
            if (p) {
              player.pokemonsProposition.push(p)
            }
          }
        }
      })
    }

    // Second additional pick stage
    if (this.state.stageLevel === AdditionalPicksStages[1]) {
      this.state.players.forEach((player: Player) => {
        if (player.isBot) {
          const p = this.room.additionalPokemonsPool2.pop()
          if (p) {
            this.state.additionalPokemons.push(p)
            this.state.shop.addAdditionalPokemon(p)
          }
        } else {
          for (let i = 0; i < 3; i++) {
            const p = this.room.additionalPokemonsPool2.pop()
            if (p) {
              player.pokemonsProposition.push(p)
            }
          }
        }
      })
    }

    const isAfterPVE = this.getPVEIndex(this.state.stageLevel - 1) >= 0
    const commands = new Array<Command>()

    this.state.players.forEach((player: Player) => {
      if (
        this.room.getBenchSize(player.board) < 8 &&
        !isAfterPVE &&
        (player.effects.list.includes(Effect.RAIN_DANCE) ||
          player.effects.list.includes(Effect.DRIZZLE) ||
          player.effects.list.includes(Effect.PRIMORDIAL_SEA))
      ) {
        const fishingLevel = player.effects.list.includes(Effect.PRIMORDIAL_SEA)
          ? 3
          : player.effects.list.includes(Effect.DRIZZLE)
          ? 2
          : 1
        const pkm = this.state.shop.fishPokemon(player, fishingLevel)
        const fish = PokemonFactory.createPokemonFromName(pkm, player)
        const x = this.room.getFirstAvailablePositionInBench(player.id)
        fish.positionX = x !== undefined ? x : -1
        fish.positionY = 0
        fish.action = PokemonActionState.FISH
        player.board.set(fish.id, fish)
        this.room.updateEvolution(player.id)
        this.clock.setTimeout(() => {
          fish.action = PokemonActionState.IDLE
        }, 1000)
      }
    })

    return commands
  }

  checkForLazyTeam() {
    const commands = new Array<Command>()

    this.state.players.forEach((player, key) => {
      const teamSize = this.room.getTeamSize(player.board)
      if (teamSize < player.experienceManager.level) {
        const numberOfPokemonsToMove = player.experienceManager.level - teamSize
        for (let i = 0; i < numberOfPokemonsToMove; i++) {
          const boardSize = this.room.getBenchSizeWithoutNeutral(player.board)
          if (boardSize > 0) {
            const coordinate = this.room.getFirstAvailablePositionInTeam(
              player.id
            )
            const p = this.room.getFirstPlaceablePokemonOnBench(player.board)
            if (coordinate && p) {
              const detail: { id: string; x: number; y: number } = {
                id: p.id,
                x: coordinate[0],
                y: coordinate[1]
              }
              const client: IClient = {
                auth: {
                  uid: key
                }
              }
              commands.push(
                new OnDragDropCommand().setPayload({
                  client: client,
                  detail: detail
                })
              )
            }
          }
        }
      }
    })
    return commands
  }

  getPVEIndex(stageLevel: number) {
    const result = NeutralStage.findIndex((stage) => {
      return stage.turn == stageLevel
    })

    return result
  }

  checkForPVE() {
    return this.getPVEIndex(this.state.stageLevel) >= 0
  }

  stopPickingPhase() {
    this.state.players.forEach((player) => {
      if (player.itemsProposition.length > 0) {
        if (player.itemsProposition.length === 3) {
          // auto pick if not chosen
          const i = pickRandomIn([...player.itemsProposition])
          if (i) {
            player.items.add(i)
          }
        }
        while (player.itemsProposition.length > 0) {
          player.itemsProposition.pop()
        }
      }

      if (player.pokemonsProposition.length > 0) {
        if (player.pokemonsProposition.length === 3) {
          // auto pick if not chosen
          const pkm = pickRandomIn([...player.pokemonsProposition])
          if (pkm) {
            this.state.additionalPokemons.push(pkm)
            this.state.shop.addAdditionalPokemon(pkm)
          }
        }
        while (player.pokemonsProposition.length > 0) {
          player.pokemonsProposition.pop()
        }
      }
    })
  }

  stopFightingPhase() {
    const isPVE = this.checkForPVE()

    this.computeAchievements()
    this.computeStreak(isPVE)
    this.computeLife()
    this.registerBattleResults(isPVE)
    this.rankPlayers()
    this.checkDeath()
    this.computeIncome()
    this.state.simulations.forEach((simulation) => {
      simulation.stop()
    })

    this.state.players.forEach((player: Player) => {
      if (player.alive) {
        if (player.isBot) {
          player.experienceManager.level = Math.min(
            9,
            Math.round(this.state.stageLevel / 2)
          )
        } else {
          if (Math.random() < 0.037) {
            const client = this.room.clients.find(
              (cli) => cli.auth.uid === player.id
            )
            if (client) {
              setTimeout(() => {
                client.send(Transfer.UNOWN_WANDERING)
              }, Math.round((5 + 15 * Math.random()) * 1000))
            }
          }
        }
        if (isPVE && player.getLastBattleResult() == BattleResult.WIN) {
          player.items.add(ItemFactory.createBasicRandomItem())
          if (this.state.shinyEncounter) {
            // give a second item if shiny PVE round
            player.items.add(ItemFactory.createBasicRandomItem())
          }
        }

        if (
          this.room.getBenchSize(player.board) < 8 &&
          player.getLastBattleResult() == BattleResult.DEFEAT &&
          (player.effects.list.includes(Effect.HATCHER) ||
            player.effects.list.includes(Effect.BREEDER))
        ) {
          const eggChance = player.effects.list.includes(Effect.BREEDER)
            ? 1
            : 0.2 * player.streak
          if (chance(eggChance)) {
            const egg = PokemonFactory.createRandomEgg()
            const x = this.room.getFirstAvailablePositionInBench(player.id)
            egg.positionX = x !== undefined ? x : -1
            egg.positionY = 0
            player.board.set(egg.id, egg)
          }
        }

        if (!player.isBot) {
          if (!player.shopLocked) {
            this.state.shop.assignShop(player, false, this.state.stageLevel)
          } else {
            this.state.shop.refillShop(player, this.state.stageLevel)
            player.shopLocked = false
          }
        }

        player.board.forEach((pokemon, key) => {
          if (pokemon.evolutionTimer !== undefined) {
            pokemon.evolutionTimer -= 1

            if (pokemon.evolutionTimer === 0) {
              const pokemonEvolved = PokemonFactory.createPokemonFromName(
                pokemon.evolution,
                player
              )

              pokemon.items.forEach((i) => {
                pokemonEvolved.items.add(i)
              })
              pokemonEvolved.positionX = pokemon.positionX
              pokemonEvolved.positionY = pokemon.positionY
              player.board.delete(key)
              player.board.set(pokemonEvolved.id, pokemonEvolved)
              player.synergies.update(player.board)
              player.effects.update(player.synergies, player.board)
            } else {
              if (pokemon.name === Pkm.EGG) {
                if (pokemon.evolutionTimer >= 2) {
                  pokemon.action = PokemonActionState.IDLE
                } else if (pokemon.evolutionTimer === 1) {
                  pokemon.action = PokemonActionState.HOP
                }
              }
            }
          }
          if (pokemon.passive === Passive.UNOWN && !pokemon.isOnBench) {
            // remove after one fight
            player.board.delete(key)
            player.board.delete(pokemon.id)
            player.synergies.update(player.board)
            player.effects.update(player.synergies, player.board)
            if (!player.shopLocked) {
              this.state.shop.assignShop(player, false, this.state.stageLevel) // refresh unown shop in case player lost psychic 6
            }
          }
        })
        // Refreshes effects (like tapu Terrains)
        player.synergies.update(player.board)
        player.effects.update(player.synergies, player.board)
      }
    })

    this.state.stageLevel += 1
    return this.checkEndGame()
  }

  initializeMinigamePhase() {
    this.state.phase = GamePhaseState.MINIGAME
    const nbPlayersAlive = [...this.state.players.values()].filter(
      (p: Player) => p.life > 0
    ).length

    let minigamePhaseDuration = ITEM_CAROUSEL_BASE_DURATION
    if (PortalCarouselStages.includes(this.state.stageLevel)) {
      minigamePhaseDuration = PORTAL_CAROUSEL_BASE_DURATION
    } else if (this.state.stageLevel !== ItemCarouselStages[0]) {
      minigamePhaseDuration += nbPlayersAlive * 2000
    }
    this.state.time = minigamePhaseDuration
    this.room.miniGame.initialize(this.state.players, this.state.stageLevel)
  }

  initializeFightingPhase() {
    this.state.simulations.clear()
    this.state.phase = GamePhaseState.FIGHT
    this.state.time = FIGHTING_PHASE_DURATION
    this.room.setMetadata({ stageLevel: this.state.stageLevel })
    updateLobby(this.room)
    this.state.botManager.updateBots()

    const stageIndex = this.getPVEIndex(this.state.stageLevel)
    this.state.shinyEncounter = this.state.stageLevel === 9 && chance(1 / 20)

    if (stageIndex !== -1) {
      this.state.players.forEach((player: Player) => {
        if (player.alive) {
          player.opponentId = "pve"
          player.opponentName = NeutralStage[stageIndex].name
          player.opponentAvatar = getAvatarString(
            PkmIndex[NeutralStage[stageIndex].avatar],
            this.state.shinyEncounter,
            Emotion.NORMAL
          )
          player.opponentTitle = "Wild"
          const pveBoard = PokemonFactory.getNeutralPokemonsByLevelStage(
            this.state.stageLevel,
            this.state.shinyEncounter
          )
          const weather = getWeather(player.board, pveBoard)
          const simulation = new Simulation(
            nanoid(),
            this.room,
            player.board,
            pveBoard,
            player,
            undefined,
            this.state.stageLevel,
            weather
          )
          player.simulationId = simulation.id
          player.simulationTeamIndex = 0
          this.state.simulations.set(simulation.id, simulation)
        }
      })
    } else {
      const matchups = selectMatchups(this.state)

      matchups.forEach((matchup) => {
        const playerA = matchup.a,
          playerB = matchup.b
        const weather = getWeather(playerA.board, playerB.board)
        const simulationId = nanoid()
        const simulation = new Simulation(
          simulationId,
          this.room,
          playerA.board,
          playerB.board,
          playerA,
          playerB,
          this.state.stageLevel,
          weather
        )
        playerA.simulationId = simulationId
        playerA.simulationTeamIndex = 0
        playerA.opponents.set(
          playerB.id,
          (playerA.opponents.get(playerB.id) ?? 0) + 1
        )
        playerA.opponentId = playerB.id
        playerA.opponentName = playerB.name
        playerA.opponentAvatar = playerB.avatar
        playerA.opponentTitle = playerB.title ?? ""

        if (!matchup.ghost) {
          playerB.simulationId = simulationId
          playerB.simulationTeamIndex = 1
          playerB.opponents.set(
            playerA.id,
            (playerB.opponents.get(playerA.id) ?? 0) + 1
          )
          playerB.opponentId = playerA.id
          playerB.opponentName = playerA.name
          playerB.opponentAvatar = playerA.avatar
          playerB.opponentTitle = playerA.title ?? ""
        }

        this.state.simulations.set(simulation.id, simulation)
      })
    }
  }
}
