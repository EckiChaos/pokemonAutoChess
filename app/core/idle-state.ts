import { PokemonActionState } from "../types/enum/Game"
import { Passive } from "../types/enum/Passive"
import Board from "./board"
import PokemonEntity from "./pokemon-entity"
import PokemonState from "./pokemon-state"

export class IdleState extends PokemonState {
  update(pokemon: PokemonEntity, dt: number, board: Board, weather: string) {
    super.update(pokemon, dt, board, weather)

    if (pokemon.status.tree) {
      if (pokemon.pp >= pokemon.maxPP) {
        if (pokemon.passive === Passive.SUDOWOODO) {
          pokemon.pp = 0 // sudowoodo should not cast immediately the first time
        }
        pokemon.status.tree = false
        pokemon.toMovingState()
      }
    } else if (pokemon.canMove) {
      pokemon.toMovingState()
    }

    if (pokemon.cooldown <= 0) {
      pokemon.cooldown = 500
      if (pokemon.passive === Passive.SUDOWOODO && pokemon.status.tree) {
        pokemon.addAttack(1)
      }
    } else {
      pokemon.cooldown -= dt
    }
  }

  onEnter(pokemon: PokemonEntity) {
    super.onEnter(pokemon)
    if (pokemon.status.tree) {
      pokemon.action = PokemonActionState.IDLE
    } else if (pokemon.status.resurecting) {
      pokemon.action = PokemonActionState.HURT
    } else {
      pokemon.action = PokemonActionState.SLEEP
    }
    pokemon.cooldown = 0
  }

  onExit(pokemon: PokemonEntity) {
    super.onExit(pokemon)
    pokemon.targetX = -1
    pokemon.targetY = -1
  }
}
